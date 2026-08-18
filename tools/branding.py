"""Regenerate the store art from the game as it currently is.

The four images CrazyGames shows were hand-captured once, from a build whose
arena looked nothing like this one — different bodies, no size-from-mass, no
siphon threads, a lobby that had emptied by the time the shot was taken. Store
art that misrepresents the game is the worst kind of stale, because the tile is
most of what decides whether anybody clicks it.

So this is a script rather than an afternoon: run it whenever the game changes.

    python3 ~/.agents/skills/webapp-testing/scripts/with_server.py \
      --server "npm run dev" --port 5180 -- python3 tools/branding.py
"""
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright

OUT = Path("games/swarm/branding")
OUT.mkdir(parents=True, exist_ok=True)
ROOT = "http://127.0.0.1:5180/"

SDK = """
window.CrazyGames = { SDK: {
  init: async () => {},
  game: { loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},
          happytime(){},updateRoom(){},leftRoom(){} },
  ad: { requestAd: (_t, cb) => cb.adFinished?.() },
  user: { isUserAccountAvailable: true,
          getUser: async () => ({ username: 'HOLLOWTIDE', userId: 'x' }),
          addAuthListener(){} },
  data: { setItem(){}, getItem: () => null },
} };
"""

# Play until the arena is at its most photogenic: rivals at visibly different
# sizes, threads running between them, the swarm thick but not a solid wall.
PLAY_TO = 205

TITLE_OVERLAY = """(subtitle) => {
  const wrap = document.createElement('div');
  wrap.id = '__brand';
  wrap.style.cssText = [
    'position:fixed','inset:0','z-index:99','pointer-events:none',
    'display:flex','flex-direction:column','align-items:center',
    'justify-content:center','gap:10px',
    'background:radial-gradient(ellipse at 50% 46%, rgba(3,7,19,0) 30%, rgba(3,7,19,.34) 62%, rgba(3,7,19,.62) 100%)',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
  ].join(';');
  const title = document.createElement('div');
  title.textContent = 'HOLLOWTIDE';
  title.style.cssText = [
    'font-size:clamp(44px,9vw,104px)','font-weight:900','letter-spacing:.10em',
    'color:#f2f7ff','text-shadow:0 0 30px rgba(3,7,19,.95), 0 0 70px rgba(118,232,255,.55), 0 8px 30px rgba(0,0,0,.95)',
  ].join(';');
  const sub = document.createElement('div');
  sub.textContent = subtitle;
  sub.style.cssText = [
    'font-size:clamp(11px,2.1vw,19px)','font-weight:800','letter-spacing:.30em',
    'color:#76e8ff','text-shadow:0 2px 14px rgba(0,0,0,.9)',
  ].join(';');
  wrap.appendChild(title); wrap.appendChild(sub);
  document.body.appendChild(wrap);
}"""


def stage(page):
    """Play a match to a good moment, then strip every piece of UI."""
    page.add_init_script(SDK)
    page.goto(ROOT, wait_until="networkidle")
    page.wait_for_function("window.__swarm && window.__swarmMode")
    page.evaluate("window.__swarmMode.select('multiplayer')")
    page.wait_for_function("window.__swarm.ui().modeSelect === false")
    # Keep the camera alive and the cards moving; a dead player is a dull photo.
    page.evaluate("""() => {
      const w = window.__swarm.getWorld();
      window.__auto = setInterval(() => {
        if (w.phase === 'levelup' && w.pendingCards?.length) w.chooseUpgrade(w.pendingCards[0].id);
        if (w.phase === 'boon' && w.pendingBoons?.length) w.chooseBoon(w.pendingBoons[0]);
        w.player.hp = w.player.maxHp;
      }, 50);
    }""")
    page.wait_for_function(f"window.__swarm.getWorld().time > {PLAY_TO}", timeout=240000)
    page.evaluate("""() => {
      clearInterval(window.__auto);
      window.__swarmHud.setPlayVisible(false);
      window.__swarmLoadout.setVisible(false);
      // The mute button is deliberately NOT part of setPlayVisible — it stays
      // reachable while a panel owns the screen — so it has to be hidden by
      // hand for a photograph.
      window.__swarmHud.muteButton.visible = false;
    }""")
    page.wait_for_timeout(700)


def shot(page, name):
    path = OUT / name
    page.screenshot(path=str(path))
    print(f"  {name}  {path.stat().st_size // 1024} KB")


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=["--disable-background-timer-throttling"])

    # Landscape cover — clean gameplay, and the branded variant.
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    stage(page)
    shot(page, "cover-1280x720.png")
    page.evaluate(TITLE_OVERLAY, "GROW · HUNT · TAKE THE CROWN")
    page.wait_for_timeout(250)
    shot(page, "cover-branded-1280x720.png")
    page.close()

    # Portrait listing, at a real phone aspect.
    page = browser.new_page(viewport={"width": 390, "height": 844})
    stage(page)
    page.evaluate(TITLE_OVERLAY, "GROW · HUNT · TAKE THE CROWN")
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / "_portrait-raw.png"))
    page.close()
    browser.close()

# The shelf tile is tiny, so it is downscaled from the clean cover rather than
# rendered at 292px — at that viewport the game zooms out and the tile becomes
# a field of specks.
subprocess.run(["sips", "-z", "172", "292", str(OUT / "cover-1280x720.png"),
                "--out", str(OUT / "tile-292x172.png")], check=True,
               stdout=subprocess.DEVNULL)
subprocess.run(["sips", "-z", "1688", "780", str(OUT / "_portrait-raw.png"),
                "--out", str(OUT / "portrait-780x1688.png")], check=True,
               stdout=subprocess.DEVNULL)
(OUT / "_portrait-raw.png").unlink()
print("  tile-292x172.png and portrait-780x1688.png rescaled")
