"""Landmarks and the skip link on the rendered ERP shell (A11Y-002).

The desktop shell had no `<main>` element anywhere and no skip link. Two
consequences, both affecting the same people:

  * "Jump to main content" -- the first thing a screen-reader user reaches
    for on an unfamiliar page -- had nothing to jump to, so the whole
    document had to be traversed linearly.
  * The sidebar carries fourteen tab buttons ahead of the content, so a
    keyboard user pressed Tab fourteen times on every page load to reach
    anything they could act on.

Asserted against the RENDERED page rather than the template file: the
landmark has to survive Jinja, the role-gated `{% if %}` blocks around
several tabs, and whatever the partials contribute. A template-text grep
would pass on markup that never reaches a browser.
"""

from __future__ import annotations

import re

import pytest

pytestmark = pytest.mark.integration


# HTML comments are stripped before any of this is examined. The page
# explains its own markup in comments -- including ones that mention <main>
# by name -- and counting those would make these tests fail on prose.
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


@pytest.fixture
def shell(erp_client):
    response = erp_client.get("/erp")
    assert response.status_code == 200, response.status_code
    return _COMMENT_RE.sub("", response.get_data(as_text=True))


# ── The landmark ─────────────────────────────────────────────────────────


def test_the_page_has_a_main_landmark(shell):
    assert re.search(r"<main\b", shell), "no <main> element in the rendered page"


def test_there_is_exactly_one_main(shell):
    """More than one and "the main content" is ambiguous again, which is the
    problem this solves."""
    assert len(re.findall(r"<main\b", shell)) == 1


def test_the_main_landmark_is_closed(shell):
    """The content wrapper was a <div>; changing the opening tag without the
    closing one yields markup that still renders but nests every following
    element inside <main>."""
    assert shell.count("</main>") == 1


def test_the_tab_panels_live_inside_main(shell):
    """A landmark wrapping none of the content is decoration. The panels are
    what a user came to read, so they have to be inside it."""
    start = shell.index("<main")
    end = shell.index("</main>")
    inside = shell[start:end]
    assert 'id="dashboardTab"' in inside
    assert 'id="stockTab"' in inside


# ── The skip link ────────────────────────────────────────────────────────


def test_a_skip_link_is_present(shell):
    assert 'class="skip-link"' in shell


def test_the_skip_link_is_the_first_focusable_thing_on_the_page(shell):
    """A skip link after the navigation saves nobody anything."""
    skip = shell.index('class="skip-link"')
    nav = shell.index('id="mainTabs"')
    assert skip < nav, "the skip link renders after the tab list"


def test_the_skip_link_points_at_the_landmark(shell):
    """href and id have to agree, and this is exactly the pair that drifts
    when either side is renamed."""
    match = re.search(r'<a href="#([\w-]+)" class="skip-link"', shell)
    assert match, "skip link has no fragment href"
    target = match.group(1)
    assert re.search(rf'<main id="{re.escape(target)}"', shell), (
        f"skip link points at #{target}, which is not the <main> element"
    )


def test_the_landmark_can_receive_focus(shell):
    """Without tabindex="-1" the browser moves the address bar's fragment but
    not keyboard focus, so the next Tab press returns to the top of the page
    and the link appears to do nothing."""
    assert re.search(r'<main id="content"[^>]*tabindex="-1"', shell)


def test_the_skip_link_is_reachable_by_keyboard():
    """Positioned off-screen, not display:none or visibility:hidden -- both
    of those remove an element from the focus order, which would make the
    link unreachable by the only people it is for."""
    from pathlib import Path

    css = (
        Path(__file__).parent.parent.parent / "static" / "erp" / "styles.css"
    ).read_text(encoding="utf-8")
    block = css[css.index(".skip-link {") :]
    rule = block[: block.index("}")]
    assert "position: absolute" in rule
    assert "display: none" not in rule
    assert "visibility: hidden" not in rule
    assert ".skip-link:focus" in css, "the link never becomes visible"
