from playwright.sync_api import sync_playwright
U="http://127.0.0.1:8137/Wilco.dc.html"
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1440,"height":900})
    pg.goto(U); pg.wait_for_timeout(7000)
    n=pg.evaluate("document.body.innerText.length"); assert n>1500, f"not mounted ({n})"
    bg=pg.evaluate("getComputedStyle(document.body).backgroundColor")
    print("mounted:", n, "| body bg:", bg)
    pg.screenshot(path="/out/ref-1440-dark-inbox.png", full_page=True); b.close()
