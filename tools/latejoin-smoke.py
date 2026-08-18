"""Joining a Hollowtide match that is already running, in real browsers.

The two-client smoke drives both tabs from one script, so they always press PLAY
in the same millisecond. That is the one case real players never produce. This
one starts a match, lets it run, and then walks a second person in — which is
the path that has to work for multiplayer to contain a second person at all.
"""

from pathlib import Path
import json
from playwright.sync_api import sync_playwright


ROOT = "http://127.0.0.1:5180"
OUT = Path("/tmp/hollowtide-latejoin")
OUT.mkdir(parents=True, exist_ok=True)


def sdk(username):
    return f"""
window.__rooms = [];
window.CrazyGames = {{ SDK: {{
  init: async () => {{}},
  game: {{
    loadingStart: () => {{}}, loadingStop: () => {{}},
    gameplayStart: () => {{}}, gameplayStop: () => {{}}, happytime: () => {{}},
    updateRoom: (room) => window.__rooms.push({{ type: 'update', ...room }}),
    leftRoom: () => window.__rooms.push({{ type: 'left' }}),
  }},
  ad: {{ requestAd: (_type, callbacks) => callbacks.adFinished?.() }},
  user: {{
    isUserAccountAvailable: true,
    getUser: async () => ({{ username: {json.dumps(username)}, userId: {json.dumps(username)} }}),
    addAuthListener: () => {{}},
  }},
  data: {{ setItem: () => {{}}, getItem: () => null }},
}} }};
"""


def enter_multiplayer(page, username):
    page.add_init_script(sdk(username))
    page.goto(ROOT, wait_until="networkidle")
    page.wait_for_function("window.__swarm && window.__swarmSession")
    page.evaluate("window.__swarmMode.select('multiplayer')")
    page.wait_for_function("window.__swarmSession.state.status === 'live'", timeout=15000)
    page.wait_for_function("window.__swarm.getWorld().phase !== 'dead'")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        args=[
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ],
    )
    errors = []
    host = browser.new_page(viewport={"width": 1280, "height": 720})
    joiner = browser.new_page(viewport={"width": 390, "height": 844})
    for label, page in (("host", host), ("joiner", joiner)):
        page.on(
            "pageerror",
            lambda exc, label=label: errors.append(f"{label}:pageerror:{exc}")
            if len(errors) < 5 else None,
        )
        page.on(
            "console",
            lambda msg, label=label: errors.append(f"{label}:console:{msg.text}")
            if msg.type == "error" else None,
        )

    # One player opens a room and plays it for a while, alone with the AI.
    host.bring_to_front()
    enter_multiplayer(host, "HOST PLAYER")
    host.wait_for_function("window.__swarm.getWorld().time > 8", timeout=30000)
    host_time_before = host.evaluate("window.__swarm.getWorld().time")
    host_room = host.evaluate("window.__swarmSession.state.room")

    # A stranger arrives mid-run.
    joiner.bring_to_front()
    enter_multiplayer(joiner, "LATE JOINER")
    state = joiner.evaluate("""() => ({
      room: window.__swarmSession.state.room,
      seed: window.__swarm.getWorld().seed,
      time: window.__swarm.getWorld().time,
      level: window.__swarm.getWorld().level,
      alive: window.__swarm.getWorld().player.alive,
      phase: window.__swarm.getWorld().phase,
      joinedAt: window.__swarmSession.joinedAt,
      names: window.__swarm.getWorld().players.map((p) => p.name),
      live: window.__swarm.getWorld().players.map((p) => p.live),
    })""")

    assert state["room"] == host_room, (state["room"], host_room)
    # The whole point: the joiner is on the room's clock, not their own.
    assert state["time"] > 6, f"joiner started at t={state['time']}, not caught up"
    assert state["alive"], "joiner inherited a dead seat"
    assert state["phase"] == "playing", state["phase"]
    assert any(state["live"]), f"joiner does not see the host as a live player: {state['live']}"
    assert "HOST PLAYER" in state["names"], state["names"]

    # And the host sees them arrive, as a person rather than as a bot.
    host.bring_to_front()
    host.wait_for_function(
        "window.__swarm.getWorld().players.some((p) => p.live && p.name === 'LATE JOINER')",
        timeout=15000,
    )
    host_state = host.evaluate("""() => ({
      time: window.__swarm.getWorld().time,
      live: window.__swarm.getWorld().players.filter((p) => p.live).map((p) => p.name),
      humans: window.__swarmSession.state.humans.slice(),
    })""")

    gap = abs(host_state["time"] - state["time"])
    assert gap < 8, f"clocks {gap:.1f}s apart after the join"

    host.screenshot(path=str(OUT / "host-live.png"))
    joiner.bring_to_front()
    joiner.screenshot(path=str(OUT / "joiner-caught-up.png"))

    assert errors == [], errors
    host.close()
    joiner.close()
    browser.close()

print({
    "room": host_room,
    "host_clock_at_join": round(host_time_before, 1),
    "joiner_clock_after_catchup": round(state["time"], 1),
    "joiner_replayed": round(state["joinedAt"], 1),
    "joiner_level_on_arrival": state["level"],
    "host_sees_live": host_state["live"],
    "errors": errors,
    "screenshots": str(OUT),
})
