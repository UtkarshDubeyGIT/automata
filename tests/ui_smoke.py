from playwright.sync_api import sync_playwright
from pathlib import Path
import os


def assert_text(page, text: str) -> None:
    page.get_by_text(text, exact=True).first.wait_for(state="visible")


with sync_playwright() as playwright:
    base_url = os.environ.get("AUTOMATA_TEST_URL", "http://localhost:3000")
    Path("test-results").mkdir(exist_ok=True)
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})

    page.goto(base_url, wait_until="networkidle")
    hero = page.locator("h1").first
    hero.wait_for(state="visible")
    assert "tell it once." in hero.inner_text()
    assert "watch work move." in hero.inner_text()
    assert_text(page, "build for free")
    page.locator('[data-testid="hero-workflow"]').wait_for(state="visible")
    page.screenshot(path="test-results/landing-desktop.png", full_page=True)

    page.goto(f"{base_url}/app", wait_until="networkidle")
    assert_text(page, "Good morning, Alex")
    assert_text(page, "Active automations")
    assert_text(page, "Recent runs")

    page.goto(f"{base_url}/app/workflows", wait_until="networkidle")
    assert_text(page, "What should run itself?")
    assert_text(page, "Create a new one")
    page.get_by_role("tab", name="My workflows").wait_for(state="visible")
    assert_text(page, "Runs history")
    page.get_by_role("tab", name="Needs your attention").wait_for(state="visible")
    page.screenshot(path="test-results/automations-create-desktop.png", full_page=True)
    page.get_by_role("tab", name="My workflows").click()
    assert_text(page, "Daily pipeline digest")
    page.screenshot(path="test-results/automations-workflows-desktop.png", full_page=True)
    page.get_by_role("tab", name="Runs history").click()
    assert_text(page, "succeeded")
    page.get_by_role("tab", name="Needs your attention").click()
    assert_text(page, "3 things are waiting on you")
    assert_text(page, "Approve and continue")
    page.screenshot(path="test-results/automations-attention-desktop.png", full_page=True)

    page.goto(f"{base_url}/app/workflows/daily-pipeline-digest", wait_until="networkidle")
    assert page.get_by_label("Workflow name").input_value() == "Daily pipeline digest"
    assert_text(page, "Run once")
    assert_text(page, "Published")
    page.locator('[data-testid="workflow-canvas"]').wait_for(state="visible")
    page.locator('[data-testid="rf__node-deals"]').click()
    page.get_by_role("heading", name="Read open deals", exact=True).wait_for(state="visible")
    assert_text(page, "Configuration")
    page.screenshot(path="test-results/builder-circular-canvas.png", full_page=True)
    page.get_by_text("Run once", exact=True).click()
    assert_text(page, "Run this automation once?")
    assert_text(page, "Run with live actions")
    page.screenshot(path="test-results/builder-run-modal.png", full_page=True)
    page.get_by_text("Run with live actions", exact=True).click()
    assert_text(page, "Supabase server keys are not configured.")
    page.screenshot(path="test-results/builder-honest-error.png", full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile.goto(base_url, wait_until="networkidle")
    mobile_hero = mobile.locator("h1").first
    mobile_hero.wait_for(state="visible")
    assert "watch work move." in mobile_hero.inner_text()
    mobile.screenshot(path="test-results/landing-mobile.png", full_page=True)

    mobile.goto(f"{base_url}/app/workflows", wait_until="networkidle")
    assert_text(mobile, "What should run itself?")
    mobile.screenshot(path="test-results/automations-mobile.png", full_page=True)

    browser.close()
