"""A configured but unreachable relay must become AI Multiplayer, never a block."""
from playwright.sync_api import sync_playwright

ROOT = "http://127.0.0.1:5180"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror:{exc}"))
    page.on(
        "console",
        lambda msg: errors.append(f"console:{msg.text}")
        if msg.type == "error" and "ERR_CONNECTION_REFUSED" not in msg.text
        else None,
    )
    page.goto(ROOT, wait_until="networkidle")
    page.wait_for_function("window.__swarmMode && window.__swarmSession")
    page.evaluate("window.__swarmMode.select('multiplayer')")
    page.wait_for_function("window.__swarm.getWorld().phase === 'playing'")
    state = page.evaluate("""() => ({
      session: window.__swarmSession.state.status,
      seats: window.__swarm.getWorld().players.length,
      ai: window.__swarm.getWorld().players.slice(1).filter((p) => !!p.brain).length,
      modeSelect: window.__swarm.ui().modeSelect,
    })""")
    assert state == {"session": "offline", "seats": 8, "ai": 7, "modeSelect": False}, state
    assert errors == [], errors
    browser.close()

print({"fallback": state, "errors": errors})
