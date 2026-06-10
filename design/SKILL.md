---
name: maranki-design
description: Use this skill to generate well-branded interfaces and assets for Maranki, a spaced-repetition vocabulary-learning app, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, iconography, and a full app UI kit for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files. It covers product context, content/tone rules, visual foundations, and iconography. The design language is a warm "paper & ink" editorial system (deep pine-teal brand + honey-amber reward color, Newsreader serif for words + Hanken Grotesk for UI), and a ground-up redesign of the original app's neon-glass look.

Key files:
- `colors_and_type.css` — all design tokens (color, type, spacing, radius, shadow, motion) + semantic type classes. Link this in any HTML you build.
- `ion-inline.js` — drop-in reliable Ionicons renderer (the product's icon set). Include it and use `<ion-icon name="…">`.
- `assets/` — wordmark + app mark.
- `preview/` — small specimen cards for every token group.
- `ui_kits/app-v2/` — the interactive React redesign of the app (canonical UI kit); lift its primitives (`ui.jsx`) and screens. See its `README.md` for the file-by-file map.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.
