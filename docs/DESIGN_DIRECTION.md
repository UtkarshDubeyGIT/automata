# Automata design direction

## The product idea

Automata is a calm operating desk for work that should move on its own. The design should make automation feel visible, understandable, and reversible—not magical or opaque.

The public site and the signed-in product use different densities, but share the same objects: workflow windows, circular modules, run states, approvals, app marks, and a warm paper-and-indigo palette.

## Public site: the living automation desk

The landing page borrows the spatial playfulness of a desktop world without copying another product’s media, mascots, stickers, or chrome. Its floating objects are real Automata concepts:

- trigger payloads, completed runs, and approval windows;
- folders for inbox and completed work;
- an actual workflow preview rather than a decorative product mockup;
- a notes window that explains the product thesis in plain language;
- template and pricing windows that remain useful, scannable product UI.

The tone is conversational and specific: “tell it once. watch work move.” Lowercase display copy creates warmth; operational labels remain concise and precise. Gloss is reserved for primary calls to action and familiar window controls so the page feels tactile without becoming nostalgic costume design.

## Product UI: an operational workspace

The signed-in shell follows the information clarity of mature automation tools:

1. A narrow indigo rail switches major product areas.
2. A white contextual panel exposes the current area’s navigation and status.
3. A global top bar owns search, creation, help, notifications, and account access.
4. The main surface changes by task: an AI starting point, a template catalog, run history, approval queue, or visual canvas.

Automata’s distinction is the central four-mode automation hub—Create, My workflows, Runs, and Needs attention—and the circular node editor inherited from the existing GrowthOS interaction language.

## Visual language

- **Brand mark:** three connected nodes rise into an arrow, expressing work moving forward through a visible route.
- **Core colors:** warm off-white `#f5f5f2`, ink `#15151b`, indigo `#6256d9`, coral `#f06f52`, aqua highlight `#92e6ff`.
- **Meaning:** indigo is navigation and creation; coral is human attention; green is live/success; yellow is a deliberate pause.
- **Surfaces:** thin charcoal or cool-gray borders, restrained shadows, and OS-style title bars. Public surfaces can rotate slightly; product surfaces stay aligned to a strict grid.
- **Type:** oversized, tightly tracked sentence-case display text outside; smaller high-contrast task language inside. Monospace is only for machine state, IDs, and status.
- **Motion:** packets, live indicators, and a typing caret communicate active work. Motion must stop under `prefers-reduced-motion`.

## Guardrails

- Do not copy Heyclicky’s videos, memes, sky treatment, folder wordmark, or exact layout.
- Do not copy Make’s purple brand gradient, logo, terminology, or page composition verbatim.
- Every decorative object should reinforce a product concept or be removed.
- Product screenshots must come from the working Automata interface; do not redraw or invent canvas states for marketing.
- Consequential writes always have an explicit preflight or approval state.
- Empty states should teach the next action, not merely announce that no data exists.
- Product pages prioritize density and legibility over the landing page’s playful composition.

## Responsive behavior

On tablets, the contextual sidebar collapses and the product-area rail remains. On phones, both collapse so the task surface gets the full viewport. Public desktop objects become a focused central story on small screens; critical copy and calls to action remain first, while decorative folders and scribbles disappear.
