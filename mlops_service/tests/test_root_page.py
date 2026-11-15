def test_root_serves_a_page_instead_of_not_found(client):
    """Opening the service's bare address in a browser is how a person wakes
    it by hand, so it must show a page - not FastAPI's {"detail":"Not Found"}."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "ML engine is running" in resp.text


def test_root_page_keeps_the_service_awake(client):
    """The page tells people to keep the tab open; that only helps if the page
    itself keeps calling the service."""
    page = client.get("/").text
    assert "/health" in page
    assert "setInterval" in page


def test_health_reports_the_keep_alive_page(client):
    """Lets the web app know it can send people to "/" rather than "/health"."""
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["keep_alive_page"] is True
