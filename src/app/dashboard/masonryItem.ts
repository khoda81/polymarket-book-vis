export function masonryItem(node: HTMLElement): { destroy(): void } {
  let frame = 0;
  let canvasHeight = "";

  const measure = (): void => {
    const grid = node.parentElement;
    if (!grid) return;

    const styles = getComputedStyle(grid);
    const rowHeight = Number.parseFloat(styles.gridAutoRows);
    const rowGap = Number.parseFloat(styles.rowGap);
    if (!Number.isFinite(rowHeight) || !Number.isFinite(rowGap)) return;

    // Break the stretch chain while measuring. Otherwise the rounded row
    // allocation becomes the next measurement (or collapses a flex chart).
    const card = node.querySelector<HTMLElement>(":scope > .card");
    const content = card?.querySelector<HTMLElement>(":scope > .cpv-wrap");
    const stage = content?.querySelector<HTMLElement>(
      ":scope > .cpv-chart-stage",
    );
    const canvas = stage?.querySelector<HTMLElement>(
      ":scope > .cpv-canvas-wrap",
    );
    node.style.alignSelf = "start";
    node.style.gridRowEnd = "auto";
    if (card) card.style.height = "auto";
    if (content) content.style.height = "auto";
    if (stage) stage.style.flex = "none";
    if (canvas) canvas.style.flex = "none";
    const naturalCardHeight = node.getBoundingClientRect().height;
    const span = Math.max(
      1,
      Math.ceil((naturalCardHeight + rowGap) / (rowHeight + rowGap)),
    );
    node.style.gridRowEnd = `span ${span}`;
    node.style.alignSelf = "";
    if (card) card.style.height = "";
    if (content) content.style.height = "";
    if (stage) stage.style.flex = "";
    if (canvas) canvas.style.flex = "";
  };

  const scheduleMeasure = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };

  const observer = new ResizeObserver(scheduleMeasure);
  observer.observe(node);
  const mutations = new MutationObserver((records) => {
    const nextCanvasHeight =
      node.querySelector<HTMLElement>(".cpv-canvas-wrap")?.style.height ?? "";
    const hasLayoutMutation = records.some((record) => {
      if (record.attributeName === "hidden" || record.attributeName === "open")
        return true;
      if (record.type !== "childList") return false;

      // Clock annotations are absolutely positioned overlays. Their text and
      // membership cannot change card geometry, so don't turn them into a
      // forced masonry measurement.
      const target = record.target as Element;
      return !target.closest?.("[data-masonry-layout-neutral]");
    });
    if (hasLayoutMutation || nextCanvasHeight !== canvasHeight) {
      canvasHeight = nextCanvasHeight;
      scheduleMeasure();
    }
  });
  mutations.observe(node, {
    attributes: true,
    attributeFilter: ["style", "hidden", "open"],
    childList: true,
    subtree: true,
  });
  scheduleMeasure();

  return {
    destroy() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
    },
  };
}
