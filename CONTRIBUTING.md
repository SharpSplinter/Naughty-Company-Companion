# Contributing to Naughty Company Companion

Thanks for helping improve Naughty Company Companion. Contributions that make the userscript clearer, safer, more accessible, and more reliable in Tampermonkey and TornPDA are welcome.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security Policy](SECURITY.md).
- Search existing issues and pull requests before opening a new one.
- For a significant feature, layout redesign, data-source change, or calculation change, open an issue first so the proposed behavior can be discussed.
- Do not submit Torn, TornStats, or other API keys; exported backups containing keys; account data that is not needed to reproduce a problem; or personal information.

## Reporting bugs

Use the bug-report form and include the userscript version, Torn page, runtime (desktop browser or TornPDA), device/browser details, steps to reproduce, the expected result, and the actual result. Redact API keys, authorization headers, and private account data from console output and screenshots.

Security-sensitive reports belong in the [private security-advisory form](https://github.com/SharpSplinter/Naughty-Company-Companion/security/advisories/new), not a public issue.

## Suggesting features

Use the feature-request form. Explain the Torn workflow it improves, who benefits, and how it should behave on both desktop and TornPDA when relevant. Mockups, examples, and concise acceptance criteria are especially useful.

## Development workflow

1. Fork the repository and create a focused branch from `main`.
2. Keep each pull request limited to one coherent change.
3. Preserve the userscript metadata, least-privilege grants, local-first storage model, and key-redaction rules.
4. Test both a regular desktop browser and TornPDA when the change affects runtime behavior, layout, storage, API transport, export, notification, or sharing behavior.
5. Run the repository checks before opening a pull request:

   ```powershell
   node --check "Naughty Company Companion.user.js"
   node --test company-companion-regression.test.js
   ```

6. Update the README, tests, and release notes or version metadata when the user-visible behavior changes.

## Code and UX expectations

- Keep API keys and user data local unless the feature explicitly documents a user-approved external request.
- Prefer documented Torn and TornStats API behavior. Clearly label derived or observed values rather than presenting them as official Torn formulas.
- Maintain desktop, narrow-desktop, and TornPDA/mobile compatibility. Avoid introducing forced horizontal scrolling or visible scrollbar clutter.
- Use accessible labels, understandable refresh/export feedback, and integer formatting for non-currency, non-percentage, and non-date values.
- Keep console diagnostics useful while never logging API keys, authorization data, or response bodies.

## Pull requests

Use the pull-request template. Describe the problem and solution, link related issues, explain testing, and call out any behavior change, migration, permission change, API dependency, or compatibility consideration.

By submitting a contribution, you agree that it may be distributed under this repository's [MIT License](LICENSE).
