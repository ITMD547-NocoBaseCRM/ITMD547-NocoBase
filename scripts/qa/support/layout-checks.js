// In-page layout probes for the responsive checks (US-26 / T-46). Each returns a list of offenders, empty when fine.

// Visible elements that stick out past the right edge of the screen and are not inside a scroll container that holds
// them (a table scrolling sideways inside its own box is fine; the whole page scrolling sideways is not).
async function pageOverflow(page, rootSelector = 'body') {
  return page.evaluate((selector) => {
    const limit = window.innerWidth + 1;
    const scrollable = (el) => {
      for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const { overflowX } = getComputedStyle(node);
        if ((overflowX === 'auto' || overflowX === 'scroll') && node.getBoundingClientRect().right <= limit)
          return true;
      }
      return false;
    };
    const root = document.querySelector(selector) || document.body;
    const offenders = [];
    for (const el of root.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue;
      if (rect.right > limit && !scrollable(el)) {
        offenders.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(
            rect.right,
          )} text="${(el.textContent || '').trim().slice(0, 30)}"`,
        );
      }
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      offenders: offenders.slice(0, 8),
    };
  }, rootSelector);
}

// Text that is cut off: a box whose content is wider than the box and which hides the overflow.
async function clippedText(
  page,
  rootSelector,
  selector = 'button, [role=tab], label, .ant-tag, .ant-statistic, h1, h2, h3',
) {
  return page.evaluate(
    ({ root, sel }) => {
      const scope = document.querySelector(root) || document.body;
      const clipped = [];
      for (const el of scope.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const { overflowX, textOverflow } = getComputedStyle(el);
        const hides = overflowX === 'hidden' || textOverflow === 'ellipsis';
        if (hides && el.scrollWidth > el.clientWidth + 1)
          clipped.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 40)}"`);
      }
      return clipped;
    },
    { root: rootSelector, sel: selector },
  );
}

// Interactive controls whose box is not fully inside [0, innerWidth] after being scrolled into view.
async function controlsOutsideViewport(
  page,
  rootSelector,
  selector = 'button, input, .ant-select, .ant-picker, [role=tab], a',
) {
  return page.evaluate(
    ({ root, sel }) => {
      const scope = document.querySelector(root) || document.body;
      const outside = [];
      for (const el of scope.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (rect.left < -1 || rect.right > window.innerWidth + 1) {
          outside.push(
            `${el.tagName.toLowerCase()} "${(
              el.textContent ||
              el.getAttribute('placeholder') ||
              el.getAttribute('aria-label') ||
              ''
            )
              .trim()
              .slice(0, 30)}" left=${Math.round(rect.left)} right=${Math.round(rect.right)}`,
          );
        }
      }
      return outside.slice(0, 8);
    },
    { root: rootSelector, sel: selector },
  );
}

module.exports = { clippedText, controlsOutsideViewport, pageOverflow };
