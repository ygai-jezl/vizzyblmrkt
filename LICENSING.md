# Licensing

Copyright (C) 2026 YouGrow.AI Limited

Licensor: YouGrow.AI Limited

YouGrow is open core. Most of this repository is free software under the GNU Affero General
Public License version 3 (AGPL-3.0), in [LICENSE](LICENSE). The Enterprise code in `src/ee`
has its own licence, the Node SDK is MIT, and a few files keep the licence of the project
they came from. This page says which licence covers each part. The `license` field in
`package.json` points here.

> The YouGrow Enterprise Licence and the additional permission below are drafts under legal
> review, not yet in force. The AGPL-3.0, MIT, SIL Open Font Licence 1.1 and ISC licences
> listed here already apply.

## Which licence covers what

| Path | Licence | Licence text |
| --- | --- | --- |
| Everything not listed below | AGPL-3.0-only | [LICENSE](LICENSE) |
| `src/ee/**` | YouGrow Enterprise Licence, version 1 (draft) | [src/ee/LICENSE](src/ee/LICENSE) |
| `sdk/node/**` | MIT | [sdk/node/LICENSE](sdk/node/LICENSE) |
| The font files listed under Fonts | SIL Open Font Licence 1.1 | the notice beside each font |
| `src/lib/brandMap/packSiblings.ts` | ISC (adapted from d3-hierarchy) | the notice in the file |
| `public/marks/**`, and the brand marks drawn in `src/components/site/BrandIcons.tsx` | None from YouGrow: trademarks of their owners | [public/marks/NOTICE.md](public/marks/NOTICE.md) |
| npm dependencies | their own licences | each package's own files |

### Fonts

Each font file is under the SIL Open Font Licence 1.1, with its notice in the same folder.

| Font files | Notice |
| --- | --- |
| `public/email-fonts/inter-*.woff` and `inter-*.woff2` | [inter-OFL.txt](public/email-fonts/inter-OFL.txt) |
| `public/email-fonts/lora-*.woff` and `lora-*.woff2` | [lora-OFL.txt](public/email-fonts/lora-OFL.txt) |
| `public/email-fonts/montserrat-*.woff` and `montserrat-*.woff2` | [montserrat-OFL.txt](public/email-fonts/montserrat-OFL.txt) |
| `public/email-fonts/nunito-*.woff` and `nunito-*.woff2` | [nunito-OFL.txt](public/email-fonts/nunito-OFL.txt) |
| `public/email-fonts/playfair-display-*.woff` and `playfair-display-*.woff2` | [playfair-display-OFL.txt](public/email-fonts/playfair-display-OFL.txt) |
| `public/email-fonts/poppins-*.woff` and `poppins-*.woff2` | [poppins-OFL.txt](public/email-fonts/poppins-OFL.txt) |
| `src/components/site/fonts/geist-latin.woff2` | [Geist-OFL.txt](src/components/site/fonts/Geist-OFL.txt) |
| `src/components/site/fonts/geist-mono-latin.woff2` | [GeistMono-OFL.txt](src/components/site/fonts/GeistMono-OFL.txt) |
| `src/components/site/fonts/noto-sans-arabic.woff2` | [NotoSansArabic-OFL.txt](src/components/site/fonts/NotoSansArabic-OFL.txt) |
| `src/components/site/fonts/unbounded-latin.woff2` | [Unbounded-OFL.txt](src/components/site/fonts/Unbounded-OFL.txt) |
| `src/components/marketing/fonts/sora-latin.woff2` | [Sora-OFL.txt](src/components/marketing/fonts/Sora-OFL.txt) |

### Third-party marks

The logos and buttons of the services YouGrow connects to (Google Analytics, Google Search
Console and the Sign in with Google button from Google LLC, the Cloudflare cloud from Cloudflare,
Inc., and the GitHub, GitLab, LinkedIn and X marks on the Accounts tab), and the Mailchimp, Gemini,
Instagram and Node.js marks on the site's "The stack" section, belong to their owners.
YouGrow shows them only to name those services, which doesn't mean any owner endorses YouGrow.
They are not covered by the AGPL-3.0, the YouGrow Enterprise Licence or the MIT licence, and this
repository grants no rights in them. [public/marks/NOTICE.md](public/marks/NOTICE.md) lists each
file with its owner and source, and what to check before you show them in your own copy.

## Additional permission under GNU AGPL version 3 section 7

> Draft under legal review, not yet in force. For lawyer review, including whether the
> wording about section 13 (users interacting with the program remotely through a computer
> network) is needed and enough.

If you modify this program, or any covered work, by combining it with the code in `src/ee`
(or a modified version of that code), the licensors of this program grant you additional
permission to convey the resulting work, and to make it available to users interacting with
it remotely through a computer network.

The code in `src/ee` stays under its own licence, the YouGrow Enterprise Licence. The
Corresponding Source of the resulting work must still include the source code of every part
covered by the AGPL-3.0, as that licence requires.

## Contributing

Outside contributions need a contributor licence agreement (CLA). See
[CONTRIBUTING.md](CONTRIBUTING.md).
