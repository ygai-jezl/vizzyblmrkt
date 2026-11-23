# Third-party marks

Every file under `public/marks/` is a logo, icon or button that belongs to another company:

- Google Analytics, Google Search Console and the Sign in with Google button belong to Google LLC.
- Cloudflare and the Cloudflare logo are trademarks and/or registered trademarks of Cloudflare, Inc. in the United States and other jurisdictions.

The Accounts tab (Settings › Connections › Accounts) also draws the GitHub, GitLab, LinkedIn and X marks, from the Simple Icons paths in `src/components/site/BrandIcons.tsx`. They belong to GitHub, Inc., GitLab Inc., LinkedIn Corporation and X Corp.

The site's "The stack" section draws the same four from that file, and the Mailchimp, Gemini, Instagram and Node.js marks. Mailchimp belongs to Intuit Inc., Gemini to Google LLC, Instagram to Meta Platforms, Inc. and Node.js to the OpenJS Foundation.

YouGrow shows these marks only to name the services it connects to. Showing them doesn't mean any of these companies endorses or sponsors YouGrow, or is affiliated with it.

These marks are not covered by the GNU AGPL version 3, the YouGrow Enterprise Licence or the MIT licence, and this repository grants no rights in them. Each stays under its owner's terms. Google's and Cloudflare's guidelines ask for permission before their product icons are used, and a permission is given to whoever asked for it, not passed on. If you run your own copy of YouGrow, check the owners' terms for your use:

- Google Analytics developer branding: https://developers.google.com/analytics/terms/branding-policy
- Google brand features: https://partnermarketinghub.withgoogle.com/brands/google/
- Sign in with Google branding: https://developers.google.com/identity/branding-guidelines
- Cloudflare trademarks: https://www.cloudflare.com/trademark/

To stop showing a connector's marks, delete the `icon` field from its manifest in `src/lib/connectors/manifests/` and its folder here; its screens then show its two letters.

## How YouGrow shows them

- Never recoloured or reshaped, and cropped only where the table below says so (the Cloudflare cloud). Each icon sits on a plain plate with the service's name beside it.
- The Google Analytics logo with its name links straight into Google Analytics (analytics.google.com), as Google's policy allows, wherever YouGrow shows Google Analytics data, at 189 by 50 pixels (Google's minimum is 154 by 50), with the white version on dark backgrounds.
- The Sign in with Google button is Google's own art, in Google's light and dark themes.

## Files

Downloaded on 22 Nov 2026 from the owners' own servers. `src/lib/connectors/marks.test.ts` checks every file here is listed, unchanged (by its SHA-256) and safe to serve.

| File | What | Owner | Source | SHA-256 |
| --- | --- | --- | --- | --- |
| `connectors/search-console/icon.png` | Google Search Console icon, 128 by 128 | Google LLC | https://www.gstatic.com/images/branding/product/2x/search_console_64dp.png | `97db2ff60097307843a6f9bfc5b936735873d3cde4262cb0283f327d3040fa46` |
| `connectors/google-analytics/icon.svg` | Google Analytics icon | Google LLC | https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg | `aa7d39ae684b9dc29b319257ad078f97fd90350aa6ace71fc9cfb66eb316c045` |
| `connectors/google-analytics/lockup-light.png` | Google Analytics logo with its name, for light backgrounds | Google LLC | https://developers.google.com/static/analytics/images/terms/lockup_ic_Analytics_horiz_272px_clr.png | `002312435b861aa805e73809a785548140378fdfae4d3d4d7d66864ddf494b09` |
| `connectors/google-analytics/lockup-dark.png` | Google Analytics logo with its name, for dark backgrounds | Google LLC | https://developers.google.com/static/analytics/images/terms/lockup_ic_Analytics_horiz_272px_wht.png | `4ca3e35eaddac99d7c4d4457579655e14e6863f903d35a6bebfde6905e40e621` |
| `connectors/cloudflare/icon.png` | The cloud from the Cloudflare logo ("CF-Logo 1.png" in the press kit's Logos.zip), cropped to the cloud with its colours unchanged | Cloudflare, Inc. | https://cf-assets.www.cloudflare.com/dzlvafdwdttg/2Twekn3xyYyd94qDYAl0ed/9ab649caa40958f195166e0d9f5d9a04/Logos.zip | `c3ed0d2bb4e9de7a6c49518d59aa6305235755cd90e80206ea93242f272b5ef2` |
| `google/signin-light.png` | Sign in with Google button, light theme, pill, 3x ("Android + Web/PNG @3x/Light" in the zip) | Google LLC | https://developers.google.com/static/identity/images/signin-assets.zip | `1785e04475553fcec1b63524af33ebfde36ff422008c371589a014c03bf224a4` |
| `google/signin-dark.png` | Sign in with Google button, dark theme, pill, 3x ("Android + Web/PNG @3x/Dark" in the zip) | Google LLC | https://developers.google.com/static/identity/images/signin-assets.zip | `c2170246da7db96313062aba5e8e39b15431b2e2fd202c563a81c498f8b2b1f8` |

The Cloudflare icon is a crop. The press kit's Logos.zip holds only the full logo with the word Cloudflare (`CF-Logo 1.png` and `CF Logo 2.jpg`), with no cloud on its own, so the icon is that logo cut to its cloud, colours unchanged. Cloudflare's trademark guidelines say not to modify its marks, so the crop is a change to clear with Cloudflare along with the permission request. Until it is cleared, deleting the `icon` field from `src/lib/connectors/manifests/cloudflare.ts` shows CF instead.

The Sign in with Google button is the PNG version from Google's zip. The zip's SVG versions draw the G's colours with an embedded HTML element (`foreignObject`), which YouGrow doesn't serve, and taking it out would change the G.
