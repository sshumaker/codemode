/**
 * Named option sets for `generate()` (bench/generate.mjs). Values only: a preset
 * never carries code, so everything it switches on is a generator option with a
 * neutral default that the rest of this repo runs on.
 */

/**
 * What the product port (experiment-lab `bench/port/build-bundle.mjs`) passes so its
 * bundle renders as it did from the generator it used to carry. Spread it under the
 * bundle's own per-build choices, which stay the builder's:
 *
 *   generate(catalogue, { ...PRODUCT_PORT_OPTIONS, validateArgs, waitBridge, apiLayout, typedReturns, allowUntyped: true })
 *
 * `waitSurface: true` rather than "auto": the port's bundles always carried the wait
 * surface, whether or not the dump marked any tool `launches` / `awaitsInputs`.
 */
export const PRODUCT_PORT_OPTIONS = Object.freeze({
	// Catalogues recorded before an upstream schema change spelled the kind in the format.
	refFormats: Object.freeze({ asset: "product-asset-ref", shape: "product-shape-ref", job: "product-job-ref" }),
	// Every id is `{format: "product-ref", "x-ref-kinds": [...]}`. Each kind word maps to
	// the category it is typed as; null marks an id that is not an asset to pass back.
	refKinds: Object.freeze({
		key: "x-ref-kinds",
		kinds: Object.freeze({
			artifact: "asset",
			image: "asset",
			video: "asset",
			audio: "asset",
			document: "asset",
			media: "asset",
			shape: "shape",
			frame: "shape",
			job: "job",
			page: null,
			folder: null,
			session: null,
		}),
	}),
	bridgeHeader: "x-product-bridge",
	bridgeHeaderNote: Object.freeze([
		"W40 §3a: 10.7% of measured rounds skipped this bridge entirely and POSTed",
		"raw JSON to HARNESS_MCP_PROXY, which cell 0's os.environ dump hands them.",
		"That is tool-calling-over-HTTP inside the codemode arm -- the very",
		"representation under test, discarded. This header is what lets the",
		"forwarder tell the two apart (and, under PRODUCT_EXTERNAL_ARM_BRIDGE_GATE,",
		"refuse the raw one with a correction naming this module).",
	]),
	waitSurface: true,
	waitCalls: Object.freeze({ read: "api.assets.read", result: "api.review.result" }),
	typesExample: Object.freeze([
		"can = await api.image.create_image_gpt_image_1_5(prompt=...)",
		"await api.image.create_image_nano_banana_pro(prompt=..., references=[can])",
		"await api.agent_tools.wait_for_assets(ids=[can])",
	]),
	constraintNotes: true,
	moduleIndex: true,
	serverAlias: false,
});
