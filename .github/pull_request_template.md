<!-- What changed and why. -->

- [ ] Changed a setup step, a screen people follow, or a message they see? Update its help page in `src/components/help/pages/` (`src/lib/help/help.test.ts` checks the links, sections and quoted messages).
- [ ] Learning: `<kind>`: own, gap or none, and why (learns and fleet only come in later steps, ADR-0017). Each new choice YouGrow makes for a brand has its line in `src/lib/loops/registry.ts`. Run `npm run ontology:doc` and paste the Learning section's diff from `docs/ONTOLOGY.md` with its Not learning count.
- [ ] Added a feature switch? List it in `apphosting.yaml` as `"false"` and in `.env.example` (`npm test` checks the first).
- [ ] First contribution? Sign the CLA (`docs/cla/individual.md`). The CLA check says if anything is missing.
