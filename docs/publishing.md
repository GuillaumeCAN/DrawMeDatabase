# Publishing DrawMeDatabase

DrawMeDatabase is released from a version tag:

- [`ci.yml`](../.github/workflows/ci.yml) runs on every pull request and on every push to `main`: lint, unit tests, the integration test in VS Code (under `xvfb-run`, on the latest VS Code and on the oldest version allowed by `engines.vscode`) and `npm run package`. The `.vsix` it builds is kept as an artifact of the run (*Summary* page, *Artifacts* section).
- [`release.yml`](../.github/workflows/release.yml) runs when a `v*` tag is pushed. It checks that the tag matches `package.json` and that `CHANGELOG.md` has a section for this version, runs `ci.yml`, creates a GitHub Release with the `.vsix` attached, then publishes that same `.vsix` to [Open VSX](https://open-vsx.org) (the registry of VSCodium, Cursor, Windsurf, Gitpod…).
- The **VS Code Marketplace** is not automated: the `.vsix` of the GitHub Release is uploaded by hand (see [Marketplace](#vs-code-marketplace)).
- [Dependabot](../.github/dependabot.yml) opens weekly update pull requests for the npm devDependencies and for the actions of the workflows. Mermaid is pinned to an exact version and only changes through these pull requests; its major versions, `@types/vscode` (which must not get ahead of `engines.vscode`) and the major versions of `@types/node` are left out and upgraded by hand.

## Release checklist

1. Update the version: `npm version 1.2.3 --no-git-tag-version` (this changes `package.json` and `package-lock.json`). Also update the version shown at the top and in the *Changelog* section of `README.md`.
2. Add a `## [v1.2.3] - YYYY-MM-DD` section to `CHANGELOG.md`. It becomes the release notes.
3. Merge into `main` and wait for CI to pass.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```

5. Follow the *Release* run in the *Actions* tab. If the tag does not match `package.json` or the changelog section is missing, it stops before publishing anything.
6. Upload the `.vsix` of the GitHub Release to the Marketplace (see [Marketplace](#vs-code-marketplace)).

If a job of the release fails (for example Open VSX before the one-time setup below is done), fix the cause and use **Re-run failed jobs**, not *Re-run all jobs*: the GitHub Release already exists and cannot be created twice. Open VSX ignores a version it already has (`--skip-duplicate`).

A version tagged before `release.yml` was in the repository (v1.1.2 and earlier) gets no release run: publish its `.vsix` by hand with the same commands.

## One-time setup

These steps need Guillaume's own accounts. No workflow does them.

### Open VSX

The namespace `GuillaumeCancalon` (the `publisher` of `package.json`, same case) is free on open-vsx.org as of October 17, 2026.

1. **Eclipse account**: [register](https://accounts.eclipse.org/user/register), and fill in *GitHub Username* with the GitHub account used to log in to open-vsx.org (`GuillaumeCAN`).
2. **Publisher Agreement**: log in to [open-vsx.org](https://open-vsx.org) with GitHub, open *Settings → Profile*, click *Log in with Eclipse*, then *Show Publisher Agreement*, read it and click *Agree*.
3. **Access token**: *Settings → Access Tokens → Generate New Token*, with a description such as `GitHub Actions DrawMeDatabase`. Copy the value: it is shown only once.
4. **Namespace**: create it with the token. `ovsx` reads the token from `OVSX_PAT`, which keeps it out of the shell history:

   ```bash
   read -rs OVSX_PAT && export OVSX_PAT
   npx ovsx create-namespace GuillaumeCancalon
   npx ovsx verify-pat GuillaumeCancalon
   ```

5. **Namespace ownership**: creating the namespace only makes you a contributor. Claim ownership by opening an issue at [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose). Until it is granted, the extension is shown as *unverified* and someone else could claim the namespace.
6. **GitHub secret**: add the token as the `OVSX_PAT` repository secret (*Settings → Secrets and variables → Actions → New repository secret*), or with `gh secret set OVSX_PAT --repo GuillaumeCAN/DrawMeDatabase`, which prompts for the value.
   The publishing job runs in the `open-vsx` environment. GitHub creates it on the first release run; it can also be created beforehand in *Settings → Environments*. There, the secret can be moved to the environment and *Required reviewers* can make each publication wait for an approval.

Open VSX scans every upload (secret detection, blocklist, names close to existing ones) and rejects it if a check fails. The error message names the check.

#### Later: trusted publishing (no secret)

open-vsx.org supports [trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing): GitHub Actions proves its identity with an OIDC token, and the registry issues a token that lives a few minutes and can only publish this extension. It requires namespace ownership and a first version published with an access token. Once both are done:

1. On open-vsx.org, *Settings → Trusted Publishers*: namespace `GuillaumeCancalon`, provider GitHub Actions, owner `GuillaumeCAN`, repository `DrawMeDatabase`, workflow `release.yml`, environment `open-vsx`.
2. In the `open-vsx` job of `release.yml`: add `permissions: { contents: read, id-token: write }`, remove `OVSX_PAT` and its check, and publish with `npx ovsx publish "$VSIX" --trusted-publishing --skip-duplicate`.
3. Delete the `OVSX_PAT` secret and revoke the token on open-vsx.org.

### VS Code Marketplace

On **December 1, 2026**, global Azure DevOps personal access tokens are retired, and a Marketplace PAT has to be global ("All accessible organizations"). So `vsce publish` with a PAT stops working: do not create a new PAT and do not store one in GitHub.

#### Default: upload by hand

1. Download the `.vsix` from the GitHub Release (or from the *Artifacts* of a CI run).
2. Open the [publisher management page](https://marketplace.visualstudio.com/manage), click `…` next to DrawMeDatabase, then *Update*, and select the `.vsix`.
3. Wait for the verification to finish, then check the new version on the extension page.

No infrastructure, and it fits a few releases a year.

#### Option: Microsoft Entra ID (not set up)

`vsce publish --azure-credential` (vsce 2.26.1 or later; the project uses 4) signs in with Microsoft Entra ID instead of a PAT. `release.yml` contains a commented `marketplace` job for it. Before uncommenting it, it has to be set up and tested on this publisher:

1. An Azure subscription (the free tier is enough) and a **user-assigned managed identity** in it. Reports say that an *App Registration* signs in but is refused when it publishes (`InvalidAccessException`): use a managed identity.
2. On the identity, a **federated credential** for GitHub Actions: organization `GuillaumeCAN`, repository `DrawMeDatabase`, entity type *Environment*, environment `marketplace`.
3. The identity's **Azure DevOps ID**, which is neither its client ID nor its object ID. Signed in as the identity (for example in a temporary workflow step after `azure/login`), run:

   ```bash
   az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
   ```

   and keep the `id` field of the answer.
4. On the publisher management page, add that ID as a member of the publisher with the **Contributor** role.
5. Add the repository variables `AZURE_CLIENT_ID` (the identity's client ID) and `AZURE_TENANT_ID` (*Settings → Secrets and variables → Actions → Variables*). They are identifiers, not secrets.
6. Uncomment the `marketplace` job and release a version.

Microsoft documents this setup for Azure Pipelines only, not for GitHub Actions, and nothing says whether it works for a publisher owned by a personal Microsoft account. Upload by hand stays the fallback.

References: [Publishing Extensions (VS Code)](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [Publishing Extensions (Open VSX)](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions), [Namespace Access (Open VSX)](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).
