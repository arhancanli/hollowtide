"""Two-browser end-to-end smoke test for Hollowtide Live Arena."""

from pathlib import Path
import json
from playwright.sync_api import sync_playwright


ROOT = "http://127.0.0.1:5180"
OUT = Path("/tmp/hollowtide-multiplayer")
OUT.mkdir(parents=True, exist_ok=True)


def reach_results(page, username):
    page.add_init_script(f"""
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
""")
    page.goto(ROOT, wait_until="networkidle")
    page.wait_for_function("window.__swarm && window.__swarmSession")
    page.evaluate("window.__swarmMode.select('solo')")
    page.wait_for_function("window.__swarm.ui().modeSelect === false")
    page.evaluate("window.__swarm.getWorld().killPlayer()")
    page.wait_for_function("window.__swarm.ui().revive === true")
    page.evaluate("window.__swarmRevive.onDecline()")
    page.wait_for_function("window.__swarm.ui().results === true")
    page.evaluate("window.__swarmResults.onSelectMultiplayer()")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        args=[
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ],
    )
    desktop = browser.new_page(viewport={"width": 1280, "height": 720})
    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    for label, page in (("desktop", desktop), ("mobile", mobile)):
        page.on(
            "pageerror",
            lambda exc, label=label: errors.append(
                f"{label}:pageerror:{getattr(exc, 'stack', str(exc))}"
            ) if len(errors) < 5 else None,
        )
        page.on(
            "console",
            lambda msg, label=label: errors.append(f"{label}:console:{msg.text}")
            if msg.type == "error" else None,
        )

    reach_results(desktop, "DESKTOP TESTER")
    reach_results(mobile, "MOBILE TESTER")
    desktop.evaluate("window.__swarmResults.onRestart()")
    mobile.evaluate("window.__swarmResults.onRestart()")

    for page in (desktop, mobile):
        page.wait_for_function("window.__swarmSession.state.status === 'live'")
        page.wait_for_function("window.__swarm.getWorld().phase === 'playing'")
        page.wait_for_function("window.__swarmSession.state.humans.length === 1")

    state_desktop = desktop.evaluate("""() => ({
      seed: window.__swarm.getWorld().seed,
      room: window.__swarmSession.state.room,
      humans: window.__swarmSession.state.humans.slice(),
      names: window.__swarm.getWorld().players.map((p) => p.name),
      roomReports: window.__rooms.slice(),
      remoteX: window.__swarm.getWorld().players[1].x,
    })""")
    state_mobile = mobile.evaluate("""() => ({
      seed: window.__swarm.getWorld().seed,
      room: window.__swarmSession.state.room,
      humans: window.__swarmSession.state.humans.slice(),
      names: window.__swarm.getWorld().players.map((p) => p.name),
      roomReports: window.__rooms.slice(),
      remoteX: window.__swarm.getWorld().players[1].x,
    })""")
    assert state_desktop["seed"] == state_mobile["seed"]
    assert state_desktop["room"] == state_mobile["room"]
    assert state_desktop["names"][1] == "MOBILE TESTER"
    assert state_mobile["names"][1] == "DESKTOP TESTER"
    assert any(r.get("roomId") == state_desktop["room"] for r in state_desktop["roomReports"])
    assert any(r.get("roomId") == state_mobile["room"] for r in state_mobile["roomReports"])

    before = mobile.evaluate("window.__swarm.getWorld().players[1].x")
    desktop.bring_to_front()
    desktop.keyboard.down("d")
    desktop.wait_for_timeout(900)
    desktop.keyboard.up("d")
    local_after = desktop.evaluate("window.__swarm.getWorld().player.x")
    assert local_after > 20, local_after
    # Headless Chromium may entirely freeze a background tab; foreground the
    # receiving client so its simulation can consume the relayed snapshots.
    mobile.bring_to_front()
    debug = None
    for _ in range(24):
        mobile.wait_for_timeout(150)
        after = mobile.evaluate("window.__swarm.getWorld().players[1].x")
        if abs(after - before) > 20:
            break
        debug = {
            "desktop": desktop.evaluate("""() => ({
              localX: window.__swarm.getWorld().player.x,
              status: window.__swarmSession.state.status,
              humans: window.__swarmSession.state.humans.slice(),
            })"""),
            "mobile": mobile.evaluate("""() => ({
              remoteX: window.__swarm.getWorld().players[1].x,
              remoteAlive: window.__swarm.getWorld().players[1].alive,
              status: window.__swarmSession.state.status,
              humans: window.__swarmSession.state.humans.slice(),
            })"""),
        }
    else:
        raise AssertionError({"movement_not_relayed": debug, "before": before})
    after = mobile.evaluate("window.__swarm.getWorld().players[1].x")
    assert abs(after - before) > 20, (before, after)

    desktop.screenshot(path=str(OUT / "desktop-live.png"))
    mobile.screenshot(path=str(OUT / "mobile-live.png"))
    # Death in the arena is a three-second cost, not the end of the session —
    # the match runs on a clock and you come back with your build and no mass.
    desktop.bring_to_front()
    before_deaths = desktop.evaluate("window.__swarm.getWorld().player.deaths")
    desktop.evaluate("window.__swarm.getWorld().killPlayer()")
    desktop.wait_for_function("window.__swarm.getWorld().player.respawnIn > 0")
    assert desktop.evaluate("window.__swarm.ui().results") is False, "arena death must not end the match"
    desktop.wait_for_function("window.__swarm.getWorld().player.alive === true", timeout=15000)
    respawned = desktop.evaluate("""() => {
      const p = window.__swarm.getWorld().player;
      return { deaths: p.deaths, mass: Math.round(p.arenaScore), hp: Math.round(p.hp),
               weapons: p.weapons.length, alive: p.alive };
    }""")
    assert respawned["deaths"] == before_deaths + 1, respawned
    assert respawned["alive"] is True, respawned
    assert respawned["weapons"] >= 1, ("respawn must keep the build", respawned)
    assert respawned["mass"] <= 100, ("respawn must cost the mass", respawned)

    # The match still ends — on its clock.
    desktop.evaluate("window.__swarm.getWorld().time = 299.5")
    desktop.wait_for_function("window.__swarm.ui().results === true", timeout=20000)
    assert desktop.evaluate("window.__swarm.ui().revive") is False
    arena_record = desktop.evaluate("""() => ({
      runs: window.__swarmMeta.current.arenaRuns,
      bestMass: window.__swarmMeta.current.arenaBestMass,
      bestPlace: window.__swarmMeta.current.arenaBestPlace,
    })""")
    assert arena_record["runs"] == 1
    assert arena_record["bestMass"] >= 100
    assert 1 <= arena_record["bestPlace"] <= 8
    desktop.screenshot(path=str(OUT / "desktop-results.png"))
    desktop.close()
    mobile.wait_for_function("window.__swarmSession.state.humans.length === 0")
    fallback = mobile.evaluate("""() => ({
      status: window.__swarmSession.state.status,
      humans: window.__swarmSession.state.humans.length,
      remoteHasBrain: !!window.__swarm.getWorld().players[1].brain,
    })""")
    assert fallback["humans"] == 0
    assert fallback["remoteHasBrain"] is True
    assert errors == [], errors
    mobile.close()
    browser.close()

print({
    "room": state_desktop["room"],
    "seed": state_desktop["seed"],
    "remote_movement": round(after - before, 2),
    "fallback": fallback,
    "errors": errors,
    "screenshots": str(OUT),
})
