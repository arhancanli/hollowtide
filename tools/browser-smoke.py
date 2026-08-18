"""Browser smoke test for the shipped Hollowtide build.

Runs against a local Vite server via the webapp-testing helper. The mocked
CrazyGames SDK makes portal lifecycle events observable without depending on
the remote preview environment.
"""

from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = "http://127.0.0.1:5180"
OUT = Path("/tmp/hollowtide-smoke")
OUT.mkdir(parents=True, exist_ok=True)


SDK_MOCK = """
window.__cgCalls = [];
const record = (name) => window.__cgCalls.push(name);
window.CrazyGames = { SDK: {
  init: async () => record('init'),
  game: {
    loadingStart: () => record('loadingStart'),
    loadingStop: () => record('loadingStop'),
    gameplayStart: () => record('gameplayStart'),
    gameplayStop: () => record('gameplayStop'),
    happytime: () => record('happytime'),
  },
  ad: {
    requestAd: (type, callbacks) => {
      record('ad:' + type);
      callbacks.adStarted?.();
      setTimeout(() => callbacks.adFinished?.(), 80);
    },
  },
  user: {
    isUserAccountAvailable: true,
    getUser: async () => null,
    showAuthPrompt: async () => null,
    addAuthListener: () => {},
  },
  data: { setItem: () => {}, getItem: () => null },
}};
"""


def run_case(browser, name, viewport):
    page = browser.new_page(viewport=viewport, device_scale_factor=1)
    errors = []
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror:{exc}"))
    page.add_init_script(SDK_MOCK)
    page.goto(ROOT, wait_until="networkidle")
    page.wait_for_function("window.__swarm && window.__swarmPortal")
    page.wait_for_function("window.__swarm.ui().modeSelect === true")

    initial = page.evaluate("""() => ({
      portal: window.__swarmPortal.name,
      ui: window.__swarm.ui(),
      calls: window.__cgCalls.slice(),
      canvas: { w: document.querySelector('canvas').width, h: document.querySelector('canvas').height },
    })""")
    page.screenshot(path=str(OUT / f"{name}-initial.png"))

    page.evaluate("window.__swarmMode.select('solo')")
    page.wait_for_function("window.__swarm.ui().modeSelect === false")

    # Force a normal death through the simulation, then accept the revive ad.
    page.evaluate("""() => {
      const world = window.__swarm.getWorld();
      world.killPlayer();
    }""")
    page.wait_for_function("window.__swarm.ui().revive === true")
    death_calls = page.evaluate("window.__cgCalls.slice()")

    # Invoke the same callback the Pixi button owns; geometry is separately
    # covered by the screenshots and avoids a brittle coordinate dependency.
    page.evaluate("window.__swarmRevive.onAccept()")
    page.wait_for_function("window.__swarm.getWorld().phase === 'playing'")
    page.wait_for_timeout(100)
    revived = page.evaluate("""() => ({
      ui: window.__swarm.ui(),
      calls: window.__cgCalls.slice(),
      hp: window.__swarm.getWorld().player.hp,
      time: window.__swarm.getWorld().time,
    })""")
    page.screenshot(path=str(OUT / f"{name}-revived.png"))

    # A second death goes directly to results. Restart must hold there until
    # the interstitial finishes; the next simulation must not run behind it.
    page.evaluate("""() => {
      const world = window.__swarm.getWorld();
      world.killPlayer();
    }""")
    page.wait_for_function("window.__swarm.ui().results === true")
    page.screenshot(path=str(OUT / f"{name}-results.png"))
    page.evaluate("window.__swarmResults.onRestart()")
    during_midgame = page.evaluate("""() => ({
      phase: window.__swarm.getWorld().phase,
      calls: window.__cgCalls.slice(),
      shield: getComputedStyle(document.querySelector('[aria-live="polite"]')).display,
    })""")
    page.wait_for_function("window.__swarm.getWorld().phase === 'playing'")
    after_midgame = page.evaluate("""() => ({
      phase: window.__swarm.getWorld().phase,
      calls: window.__cgCalls.slice(),
      time: window.__swarm.getWorld().time,
      shield: getComputedStyle(document.querySelector('[aria-live="polite"]')).display,
    })""")
    assert initial["portal"] == "crazygames"
    assert initial["ui"]["modeSelect"] is True
    assert initial["calls"] == ["init", "loadingStart", "loadingStop"]
    assert death_calls[-1] == "gameplayStop"
    assert revived["calls"][-2:] == ["ad:rewarded", "gameplayStart"]
    assert during_midgame["phase"] == "dead"
    assert during_midgame["calls"][-1] == "ad:midgame"
    assert during_midgame["shield"] == "flex"
    assert after_midgame["phase"] == "playing"
    assert after_midgame["calls"][-1] == "gameplayStart"
    assert after_midgame["time"] < 0.2
    assert after_midgame["shield"] == "none"
    assert errors == []
    page.close()
    return {
        "initial": initial,
        "death_calls": death_calls,
        "revived": revived,
        "during_midgame": during_midgame,
        "after_midgame": after_midgame,
        "errors": errors,
    }


with sync_playwright() as playwright:
    chromium = playwright.chromium.launch(headless=True)
    desktop = run_case(chromium, "desktop", {"width": 1280, "height": 720})
    mobile = run_case(chromium, "mobile", {"width": 390, "height": 844})
    landscape = run_case(chromium, "landscape", {"width": 844, "height": 390})
    chromium.close()

print({"desktop": desktop, "mobile": mobile, "landscape": landscape, "screenshots": str(OUT)})
