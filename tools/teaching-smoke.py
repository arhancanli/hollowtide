"""Do the arena lessons actually fire, and only once?

Three mechanics were added to the arena — mass as a body, the siphon, and dying
as a cost — and a lesson that never triggers is indistinguishable from no
lesson at all. This boots a BRAND NEW player (storage cleared before the app
reads it), plays a match, and records every line the banner said; then plays a
second match and requires that none of the lessons repeat.

It has already earned its keep: the first version of the teaching told players
they were "draining" somebody before it told them what mass was, and the
hurt-rival lesson was gated on the rival being a live human, so it could never
fire in a lobby of AI — which is every lobby until the relay is deployed.

    python3 ~/.agents/skills/webapp-testing/scripts/with_server.py \
      --server "npm run dev" --port 5180 -- python3 tools/teaching-smoke.py
"""
from playwright.sync_api import sync_playwright

SDK = """
window.CrazyGames = { SDK: {
  init: async () => {}, game: { loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},
    happytime(){},updateRoom(){},leftRoom(){} },
  ad: { requestAd: (_t, cb) => cb.adFinished?.() },
  user: { isUserAccountAvailable: true, getUser: async () => ({ username: 'NEW', userId: 'new' }), addAuthListener(){} },
  data: { setItem(){}, getItem: () => null },
} };
"""
HOOK = """() => {
  window.__said = [];
  const hud = window.__swarmHud;
  const real = hud.announceArena.bind(hud);
  hud.announceArena = (msg, pri) => { window.__said.push(msg); return real(msg, pri); };
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--disable-background-timer-throttling"])
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.add_init_script(SDK)
    # A brand-new player: clear storage before the app boots and reads it.
    page.add_init_script("try { localStorage.clear(); } catch (e) {}")
    page.goto("http://127.0.0.1:5180/", wait_until="networkidle")
    page.wait_for_function("window.__swarm && window.__swarmMode && window.__swarmHud")
    page.evaluate(HOOK)
    page.evaluate("window.__swarmMode.select('multiplayer')")
    page.wait_for_function("window.__swarm.ui().modeSelect === false")
    page.evaluate("""() => { const w = window.__swarm.getWorld();
      window.__auto = setInterval(() => {
        if (w.phase === 'levelup' && w.pendingCards?.length) w.chooseUpgrade(w.pendingCards[0].id);
        if (w.phase === 'boon' && w.pendingBoons?.length) w.chooseBoon(w.pendingBoons[0]);
      }, 50); }""")
    page.wait_for_function("window.__swarm.getWorld().time > 75", timeout=180000)
    first = page.evaluate("() => ({ said: window.__said.slice(), taught: window.__swarmMeta.current.taught.slice() })")

    print("FIRST MATCH — lessons recorded:", first["taught"])
    for m in dict.fromkeys(first["said"]):
        print("   said:", m)

    # Second match: the lessons must not repeat.
    page.evaluate("() => { window.__said = []; }")
    page.evaluate("window.__swarm.getWorld().time = 299.4")
    page.wait_for_function("window.__swarm.ui().results === true", timeout=30000)
    page.evaluate("window.__swarmResults.onRestart()")
    page.wait_for_function("window.__swarm.getWorld().time > 1 && window.__swarm.getWorld().time < 40", timeout=60000)
    page.evaluate("""() => { const w = window.__swarm.getWorld();
      window.__auto = setInterval(() => {
        if (w.phase === 'levelup' && w.pendingCards?.length) w.chooseUpgrade(w.pendingCards[0].id);
        if (w.phase === 'boon' && w.pendingBoons?.length) w.chooseBoon(w.pendingBoons[0]);
      }, 50); }""")
    page.wait_for_function("window.__swarm.getWorld().time > 40", timeout=120000)
    second = page.evaluate("() => window.__said.slice()")
    repeats = [m for m in second if m in first["said"] and ("MASS IS YOUR SIZE" in m or "DRAINING" in m or "COSTS YOUR MASS" in m or "IS HURT" in m)]
    print("SECOND MATCH — lesson lines repeated:", repeats or "none")
    print("errors:", errs[:3])
    assert "arena.mass" in first["taught"], "the first thing a player is told never fired"
    assert len(first["taught"]) >= 3, ("too few lessons fired", first["taught"])
    assert first["said"].index("MASS IS YOUR SIZE  ·  MOST MASS AT THE CLOCK WINS") < min(
        [i for i, m in enumerate(first["said"]) if "DRAINING" in m] or [10**6]
    ), "a player was told they were draining something before being told what mass is"
    assert not repeats, ("a lesson repeated in a later match", repeats)
    assert errs == [], errs
    b.close()
