/**
 * HARNESS_DISPLAY_IMAGES=1: a plain image display (matplotlib's inline backend,
 * IPython.display.Image) becomes an attachment, exactly as if the attach-image skill had
 * emitted it. Upstream captures only the skill's own MIME, so a chart shown with
 * plt.show() reached neither the model nor the host that renders the cell.
 *
 * Off by default: an image in the tool result is tokens in context, which is a measured
 * condition for every benchmark in this repo. A product host (one that shows cells to a
 * person) turns it on.
 */
const HARNESS_DISPLAY_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
function harnessDisplayImage(data: Record<string, unknown> | undefined): KernelAttachment | "oversized" | undefined {
	if (process.env.HARNESS_DISPLAY_IMAGES !== "1" || !data) return undefined;
	for (const mimeType of HARNESS_DISPLAY_IMAGE_MIMES) {
		const raw = data[mimeType];
		const b64 = Array.isArray(raw) ? raw.join("") : raw;
		if (typeof b64 !== "string" || !b64) continue;
		const clean = b64.replace(/\s+/g, "");
		if (clean.length > MAX_ATTACHMENT_DATA_CHARS) return "oversized";
		return { mimeType, data: clean };
	}
	return undefined;
}
