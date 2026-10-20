# Publishing DrawMeDatabase

DrawMeDatabase is released when the version of `package.json` changes on `main`:

- [`ci.yml`](../.github/workflows/ci.yml) runs on every pull request and on every push to `main`: lint, unit tests, the integration test in VS Code (under `xvfb-run`, on the latest VS Code and on the oldest version allowed by `engines.vscode`) and `npm run package`. The `.vsix` it builds is kept as an artifact of the run (*Summary* page, *Artifacts* section). On a pull request to `main` that changes the version, its job *Version and changelog of the release* also runs the checks of the release that the merge will start.
- [`release.yml`](../.github/workflows/release.yml) runs on every push to `main`. When the version of `package.json` already has its `v<version>` tag, it stops after a few seconds with the notice *Nothing to publish*. Otherwise it checks that `CHANGELOG.md` has a dated section for this version, runs `ci.yml` on that commit, creates the tag `v<version>` and the GitHub Release (with the `.vsix` attached) at that commit, then publishes that same `.vsix` to [Open VSX](https://open-vsx.org) (the registry of VSCodium, Cursor, Windsurf, Gitpod…) and to the **VS Code Marketplace**.
- [`marketplace-identity.yml`](../.github/workflows/marketplace-identity.yml) is run by hand during the [Marketplace setup](#vs-code-marketplace). It publishes nothing.
- [Dependabot](../.github/dependabot.yml) opens weekly update pull requests for the npm devDependencies and for the actions of the workflows. Mermaid is pinned to an exact version and only changes through these pull requests; its major versions, `@types/vscode` (which must not get ahead of `engines.vscode`) and the major versions of `@types/node` are left out and upgraded by hand.

**DrawMeDatabase Pro** (`GuillaumeCAN/DrawMeDatabase-Pro`) is released the same way, by a `release.yml` of its own with the same jobs and checks; its `docs/publishing.md` lists what differs (private repository, tests against the `main` branch of DrawMeDatabase). The Open VSX token, the Azure identity and the Marketplace publisher below serve both extensions.

A registry that is not set up yet does not make the release fail: the run shows a warning (*Open VSX not published*, *VS Code Marketplace not published*) and the rest of the release is done. The [one-time setup](#one-time-setup) below removes the warnings.

## Release checklist

1. In the pull request of the version:
   - update the version: `npm version 1.2.3 --no-git-tag-version` (this changes `package.json` and `package-lock.json`), and the version shown at the top and in the *Changelog* section of `README.md`;
   - add a `## [v1.2.3] - YYYY-MM-DD` section to `CHANGELOG.md`. It becomes the release notes. While the version is in progress, the heading can say `## [v1.2.3] - Unreleased`: the check *Version and changelog of the release* of the pull request then fails, as a reminder, because the release refuses it. Write the date in the last commit before merging; the check turns green.
2. Merge the pull request into `main`. That push starts the *Release* run: nothing else to do. No tag to push.
3. Follow the run in the *Actions* tab (workflow *Release*). Its jobs:
   1. *Version, tag and changelog* decides. If the version already has its tag, the run ends here, green, with *Nothing to publish*. If the changelog section is missing, empty or dated `Unreleased`, or if the version is lower than the latest release, it fails with an error that says what to fix, and nothing is published.
   2. *CI* (the jobs of `ci.yml`) lints, tests and packages the `.vsix` of that commit.
   3. *Tag and GitHub Release* creates the tag `v1.2.3` and the release at that commit, with the `.vsix`.
   4. *Publish to Open VSX* and *Publish to the VS Code Marketplace* publish the same `.vsix`.
4. Check the new version on the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=GuillaumeCancalon.draw-me-database) and on the [Open VSX page](https://open-vsx.org/extension/GuillaumeCancalon/draw-me-database).

### When something goes wrong

- **The decide job failed** (changelog, version): nothing was created. Fix it in a new pull request; its merge runs *Release* again.
- **A publishing job failed** after the GitHub Release was created (a registry refused the upload, the Marketplace sign-in failed…): fix the cause, then *Re-run failed jobs*. *Re-run all jobs* also works: the decide job recognizes the re-run of the tagged commit, the existing tag and release are kept, and the registries skip a version they already have (`--skip-duplicate`).
- **Publish an already released version again**, for example to the Marketplace once its setup is done, or to Open VSX once `OVSX_PAT` is set: *Actions → Release → Run workflow → Use workflow from → Tags → v1.2.3 → Run workflow*. The release is kept, and each registry publishes the version only if it does not have it. This also works for a version older than the latest release, because its GitHub Release exists; Open VSX accepts an older version, the Marketplace may refuse one that is lower than its latest.
- **Upload to the Marketplace by hand**: see the [fallback](#fallback-upload-by-hand).

### Good to know

- A tag pushed by hand (`git tag v1.2.3 && git push origin v1.2.3`) still runs the same release, if `package.json` says `1.2.3` at that commit **and the commit is on `main`**; a tag on a branch that was never merged is refused. It is no longer needed. *Run workflow* on `main` does the same as a push to `main`.
- A version lower than the latest release (`package.json` reverted, an old tag pushed by hand) is refused, unless that version already has its GitHub Release: then it is published again where it is missing.
- The tag that the workflow creates (with the `GITHUB_TOKEN`) does not start another workflow run: publishing happens in the same run, after the release.
- Releases run one at a time and are never cancelled while they run. GitHub keeps only one run waiting: when a push, a tag or a *Run workflow* starts a run while another one waits, the older waiting run is shown as cancelled. If both are pushes to `main`, the newer one does the work (a version still unreleased is then released from the newer commit); a cancelled *Run workflow* has to be started again once the release is over.
- A push to `main` that releases builds the `.vsix` twice, in parallel: once in *CI*, once in *Release*. A push that does not change the version only adds the few seconds of the decide job.
- A `v*` tag runs the `release.yml` of the tagged commit. A version tagged before `release.yml` was in the repository (v1.1.2 and earlier) gets no release run, and one tagged before 1.8.0 runs the older, tag-driven `release.yml`: publish their `.vsix` by hand if needed.

## One-time setup

These steps need Guillaume's own accounts. No workflow does them.

### Open VSX

The `open-vsx` job publishes with the `OVSX_PAT` secret. Until the secret is set, it shows the warning *Open VSX not published* and skips the publication, and the release stays green.

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
6. **GitHub environment `open-vsx`**: in [GuillaumeCAN/DrawMeDatabase](https://github.com/GuillaumeCAN/DrawMeDatabase), **Settings → Environments → New environment**, *Name* `open-vsx`, **Configure environment**:
   1. *Deployment branches and tags*: **Selected branches and tags**. **Add deployment branch or tag rule**: *Ref type* **Branch**, *Name pattern* `main`, **Add rule**. Again: *Ref type* **Tag**, *Name pattern* `v*.*.*`, **Add rule**.
   2. *Environment secrets* **→ Add environment secret**: *Name* `OVSX_PAT`, *Value* the token of step 3.

   The token is then given only to the jobs of this environment, which only runs from `main` and from version tags: a workflow pushed on another branch cannot read it. Do not store it as a repository secret, which every workflow of every branch can read. Create the environment before the first release: a release that names an environment that does not exist creates it, without these rules.
7. **DrawMeDatabase Pro**: the token publishes to every namespace of its account. Do step 6 again in [GuillaumeCAN/DrawMeDatabase-Pro](https://github.com/GuillaumeCAN/DrawMeDatabase-Pro), with the same token. If *Settings → Environments* is missing there (a private repository, see [step 6 of the Marketplace](#6-github-environment-marketplace-both-repositories)), store it as the `OVSX_PAT` repository secret instead (*Settings → Secrets and variables → Actions → New repository secret*).
8. **Versions released before the secret**: publish each one with *Run workflow* on its tag (see [When something goes wrong](#when-something-goes-wrong)).

Open VSX scans every upload (secret detection, blocklist, names close to existing ones) and rejects it if a check fails. The error message names the check.

#### Later: trusted publishing (no secret)

open-vsx.org supports [trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing): GitHub Actions proves its identity with an OIDC token, and the registry issues a token that lives a few minutes and can only publish this extension. It requires namespace ownership and a first version published with an access token. Once both are done:

1. On open-vsx.org, *Settings → Trusted Publishers*: namespace `GuillaumeCancalon`, provider GitHub Actions, owner `GuillaumeCAN`, repository `DrawMeDatabase`, workflow `release.yml`, environment `open-vsx`. The same for `DrawMeDatabase-Pro`.
2. In the `open-vsx` job of `release.yml`: set `permissions: { contents: read, id-token: write }`, remove the *Token* step and the `if:` of the other steps, remove `OVSX_PAT` from the *Publish* step, and publish with `npx ovsx publish "$VSIX" --trusted-publishing --skip-duplicate`.
3. Delete the `OVSX_PAT` secrets and revoke the token on open-vsx.org.

### VS Code Marketplace

On **December 1, 2026**, global Azure DevOps personal access tokens are retired, and a Marketplace PAT has to be global ("All accessible organizations"). So `vsce publish` with a PAT stops working: do not create a new PAT and do not store one in GitHub.

The `marketplace` job of `release.yml` publishes with **Microsoft Entra ID** instead: `vsce publish --azure-credential` signed in as a **user-assigned managed identity** in Azure, which GitHub Actions signs in to with an OIDC token (`azure/login`). No secret is stored anywhere: Azure trusts the OIDC tokens of one GitHub environment, `marketplace`, of the two repositories.

Until the repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are set, the `marketplace` job is skipped and the job *VS Code Marketplace not set up* shows the warning *VS Code Marketplace not published*: [upload the `.vsix` by hand](#fallback-upload-by-hand).

> **What Microsoft documents, and what it does not**
>
> - Documented: `vsce publish --azure-credential`, and publishing as a managed identity added to the publisher with its Azure DevOps ID — from **Azure Pipelines** (a service connection with workload identity federation).
> - Documented separately: signing in to Azure from GitHub Actions with `azure/login` and a federated credential on a user-assigned managed identity — for deploying Azure resources.
> - Documented in the README of vsce, not on the VS Code site: `vsce publish --oidc`, trusted publishing from GitHub Actions without Azure. See [step 0](#0-before-you-start-trusted-publishing-without-azure).
> - **Not documented by Microsoft**: the combination of the first two, the Marketplace from **GitHub Actions** through Entra ID. Nor whether a publisher owned by a **personal Microsoft account** (which `GuillaumeCancalon` is) accepts as a member an identity of an Entra tenant. The steps marked *(not documented)* below come from the Azure Pipelines procedure, from vsce's code and from user reports.
>
> The upload by hand stays the fallback if a step does not work.

#### Step-by-step setup

What it creates (the names are suggestions, any name works except `marketplace`, which the workflows use):

| What | Where | Name or value |
| --- | --- | --- |
| Subscription | Azure | the one of the free account |
| Resource group | Azure | `rg-drawmedatabase-publishing` |
| User-assigned managed identity | Azure | `id-drawmedatabase-marketplace` |
| Federated credentials | on the identity | `github-drawmedatabase`, `github-drawmedatabase-pro` |
| Environment | both GitHub repositories | `marketplace` |
| Member of the publisher | Marketplace | the identity's Azure DevOps ID, role *Contributor* |
| Repository variables | both GitHub repositories | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` |

Count about 30 minutes. A user-assigned managed identity costs nothing: the subscription stays at 0 €.

**Order.** Steps 0 to 6 can be done at any time, before or after the merge of 1.8.0. Step 7 runs `marketplace-identity.yml`, which GitHub can only run from `main` (*Run workflow* is listed only for a workflow of the default branch): after the merge of 1.8.0, the version that adds it. Step 9 turns the publication on: do it last, once step 8 shows that the identity has a role on the publisher. Until then, every release keeps showing *VS Code Marketplace not published*, and nothing fails.

##### 0. Before you start: trusted publishing, without Azure

vsce 4.0.0, the version in `package-lock.json`, has a second way to publish without a PAT: `vsce publish --oidc`. Its README (section *Trusted publishing*, in `node_modules/@vscode/vsce/README.md`) documents it: a **trusted publishing policy** for the repository and the workflow is configured on the Visual Studio Marketplace, the job gets `id-token: write`, and vsce exchanges a GitHub OIDC token (audience `marketplace.visualstudio.com`) for a short-lived Marketplace credential. The option is hidden from `vsce --help`, and the VS Code publishing documentation does not mention it as of October 20, 2026.

This path needs no Azure account, no payment card and no identity. Look first:

1. Open [marketplace.visualstudio.com/manage/publishers/GuillaumeCancalon](https://marketplace.visualstudio.com/manage/publishers/GuillaumeCancalon), signed in with the account that owns the publisher, and look for a *trusted publishing* (or *trusted publisher*, *publishing policy*) setting.
2. **If there is one**: create a policy for owner `GuillaumeCAN`, repository `DrawMeDatabase`, workflow `release.yml` (and environment `marketplace`, if it asks for one), and the same for `DrawMeDatabase-Pro`. Do [step 6](#6-github-environment-marketplace-both-repositories) (the environment), skip the other steps, and change the `marketplace` job of both `release.yml`: remove the `azure/login` step, publish with `npx vsce publish --packagePath "$VSIX" --oidc --skip-duplicate`, and replace its `if:` (and the `if:` of *VS Code Marketplace not set up*) with a repository variable of its own, such as `MARKETPLACE_TRUSTED_PUBLISHING`. Keep `id-token: write` and `environment: marketplace`.
3. **If there is none**: follow steps 1 to 10 below.

##### 1. Azure account and subscription

1. Open [azure.microsoft.com/free](https://azure.microsoft.com/free) and start the free account. Sign in with a Microsoft account (the one that owns the publisher keeps things in one place, but any account works).
2. Azure asks for a phone number and a payment card to verify the identity. The free account is not charged.
3. At the end, the [Azure portal](https://portal.azure.com) opens. In *Subscriptions*, there is one subscription (for example *Azure subscription 1*, offer *Free Trial*).
4. The free trial lasts 30 days. A trial that is not upgraded is then disabled, and the identity is a resource of that subscription: do not count on it working after that. Before the end, open the subscription and click *Upgrade* (pay-as-you-go). With only the identity in it, nothing is billed. Optionally, add a safety net: *Cost Management → Budgets → Add*, amount 1 €, with an e-mail alert.
5. Signing up created a **Microsoft Entra tenant** (*Default Directory*): the identity will live there. Its ID is copied in step 5.

##### 2. Resource group

1. In the portal search bar, open **Resource groups**, then **Create**.
2. *Subscription*: the one of step 1. *Resource group*: `rg-drawmedatabase-publishing`. *Region*: a main region near you, such as *France Central* or *West Europe*.
3. **Review + create**, then **Create**.

##### 3. User-assigned managed identity

1. In the search bar, open **Managed Identities**, then **Create**.
2. *Subscription*: the same. *Resource group*: `rg-drawmedatabase-publishing`. *Region*: the same main region (a few recent regions do not support federated credentials on managed identities). *Name*: `id-drawmedatabase-marketplace`.
3. **Review + create**, then **Create**, then **Go to resource**.

It must be a managed identity, not an *App registration*: users report that an app registration signs in but that the Marketplace refuses its publication with `InvalidAccessException` *(not documented)*.

##### 4. Federated credentials (one per repository)

They tell Entra ID to accept the OIDC tokens that GitHub issues to the jobs of the `marketplace` environment. On the identity: **Settings → Federated credentials → Add Credential**.

1. For the core extension:
   - *Federated credential scenario*: **GitHub Actions deploying Azure resources** (the name says Azure resources, it is the right one: it only builds the subject below).
   - *Organization*: `GuillaumeCAN`
   - *Repository*: `DrawMeDatabase`
   - *Entity*: **Environment**
   - *Environment*: `marketplace`
   - *Name*: `github-drawmedatabase`
   - Check the values the portal shows: *Issuer* `https://token.actions.githubusercontent.com`, *Subject identifier* `repo:GuillaumeCAN/DrawMeDatabase:environment:marketplace`, *Audience* `api://AzureADTokenExchange` (the default: do not change it).
   - **Add**.
2. Again, for DrawMeDatabase Pro: *Repository* `DrawMeDatabase-Pro`, *Entity* **Environment**, *Environment* `marketplace`, *Name* `github-drawmedatabase-pro`. Subject: `repo:GuillaumeCAN/DrawMeDatabase-Pro:environment:marketplace`.

The subject is compared character by character, case included: owner and repository as GitHub writes them, environment `marketplace` in lowercase. A job that has no `environment:` sends another subject (`repo:GuillaumeCAN/DrawMeDatabase:ref:refs/heads/main`) and is refused: this is why only the jobs of the `marketplace` environment can publish.

##### 5. Client ID and tenant ID

1. On the identity, **Overview**: copy the **Client ID**. Not the *Object (principal) ID*.
2. In the search bar, open **Microsoft Entra ID**, **Overview**: copy the **Tenant ID**.

Both are identifiers, not secrets. Keep them at hand for steps 7 and 9.

##### 6. GitHub environment `marketplace` (both repositories)

Create it now, before any workflow uses it: a job that names an environment that does not exist creates it, with no deployment rules.

In [GuillaumeCAN/DrawMeDatabase](https://github.com/GuillaumeCAN/DrawMeDatabase): **Settings → Environments → New environment**.

1. *Name*: `marketplace`, then **Configure environment**.
2. *Deployment branches and tags*: **Selected branches and tags**. **Add deployment branch or tag rule**: *Ref type* **Branch**, *Name pattern* `main`, **Add rule**. Again: *Ref type* **Tag**, *Name pattern* `v*.*.*`, **Add rule**. Only runs from `main` and from version tags can then sign in as the identity.
3. Optional: *Required reviewers*: yourself. Each Marketplace publication, and each run of *Marketplace identity*, then waits for your approval in the run (*Review deployments*).
4. Add no secret and no variable to this environment.

Do the same in [GuillaumeCAN/DrawMeDatabase-Pro](https://github.com/GuillaumeCAN/DrawMeDatabase-Pro).

DrawMeDatabase-Pro is a private repository: GitHub documents environments in private repositories for GitHub Pro, Team and Enterprise only, and required reviewers in private repositories for Enterprise only. If *Settings → Environments* is missing in DrawMeDatabase-Pro, upgrade the account to GitHub Pro, or change its credential (step 4) to *Entity* **Branch** `main` and remove `environment:` from the `marketplace` job of its `release.yml` (*Run workflow* on a tag would then need one more credential, *Entity* **Tag** with the exact tag name). Not tested.

##### 7. Azure DevOps ID of the identity

After the merge of 1.8.0 (see *Order* above). The Marketplace knows the identity by its **Azure DevOps ID**, which is neither its client ID nor its object ID.

1. In DrawMeDatabase: **Actions → Marketplace identity → Run workflow**. *Use workflow from*: `main`. Paste the client ID and the tenant ID of step 5 in the two fields of the form, then **Run workflow**. (Once the variables of step 9 exist, the fields can stay empty.)
2. Open the run. If you set required reviewers in step 6, the job *Azure DevOps ID of the publishing identity* waits: **Review deployments**, check `marketplace`, **Approve and deploy**.
3. The *Summary* shows the **ID** and the display name of the identity (they are also in the log of the *Azure DevOps ID* step).
4. The last step, *Membership of the publisher*, ends with the warning "no role on the publisher yet": expected at this point.

The workflow signs in as the identity and calls the Azure DevOps profile API (`az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798`), as the Azure Pipelines procedure does. One identity serves both repositories: the ID is the same, run it once. A run of *Marketplace identity* also proves that the federated credential of DrawMeDatabase and its environment work; the one of DrawMeDatabase-Pro is first used by a release of Pro.

##### 8. Add the identity to the publisher

1. Open the publisher's page: [marketplace.visualstudio.com/manage/publishers/GuillaumeCancalon](https://marketplace.visualstudio.com/manage/publishers/GuillaumeCancalon), signed in with the account that owns it.
2. **Members** tab **→ Add**.
3. Paste the **Azure DevOps ID** of step 7 in the user field, select the role **Contributor**, then **Add**.
4. Run **Marketplace identity** again, with the same two fields: the last step now says "The identity has a role on the publisher".

The membership covers every extension of the publisher: DrawMeDatabase and DrawMeDatabase Pro. Whether the Members page of a publisher owned by a personal Microsoft account accepts this ID is *not documented*: if it refuses it, see [Troubleshooting](#troubleshooting).

##### 9. Repository variables (both repositories): turn the publication on

In each repository: **Settings → Secrets and variables → Actions → Variables** tab **→ New repository variable**:

- `AZURE_CLIENT_ID`: the client ID of step 5;
- `AZURE_TENANT_ID`: the tenant ID of step 5.

Or from a terminal:

```bash
gh variable set AZURE_CLIENT_ID --repo GuillaumeCAN/DrawMeDatabase --body "<client ID>"
gh variable set AZURE_TENANT_ID --repo GuillaumeCAN/DrawMeDatabase --body "<tenant ID>"
gh variable set AZURE_CLIENT_ID --repo GuillaumeCAN/DrawMeDatabase-Pro --body "<client ID>"
gh variable set AZURE_TENANT_ID --repo GuillaumeCAN/DrawMeDatabase-Pro --body "<tenant ID>"
```

They must be **repository** variables, not variables of the `marketplace` environment: the condition of the `marketplace` job is evaluated before the job enters its environment, and does not see the environment's variables.

From now on, every release of the repository publishes to the Marketplace.

##### 10. First automated release

- **The versions released before step 9** (1.8.0, released at its merge, and Pro 1.1.0 if it was merged before): *Run workflow* on their tag (*Actions → Release → Run workflow → Use workflow from → Tags → v1.8.0*), in each repository. The job *Publish to the VS Code Marketplace* publishes the version; its log ends with `Published GuillaumeCancalon.draw-me-database v1.8.0.`, and the job's environment links to the Marketplace page. If the version was already uploaded by hand, vsce prints `Version 1.8.0 is already published. Skipping publish.`: the sign-in and the read access work, but the right to publish is only proven by a new version.
- **The next versions**, released as in the [checklist](#release-checklist), publish to the Marketplace on their own.

If something fails, the GitHub Release and Open VSX are already done: [upload by hand](#fallback-upload-by-hand) and look at [Troubleshooting](#troubleshooting).

#### Troubleshooting

Signing in (`azure/login` step):

- **`Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable`**, or a message asking for the `id-token: write` permission: the job cannot request an OIDC token. The `marketplace` job of `release.yml` and the identity job of `marketplace-identity.yml` declare `permissions: id-token: write`; it must stay there. Workflows started from a fork never get it.
- **`AADSTS700213: No matching federated identity record found for presented assertion subject 'repo:…'`** (or the older `AADSTS70021`): the subject that GitHub sent, quoted in the message, matches no federated credential. Compare it with step 4: owner and repository with their case, *Entity* **Environment** (not *Branch*), environment `marketplace`. A job without `environment:` sends `…:ref:refs/heads/main`. If the message names the issuer or the audience instead, check `https://token.actions.githubusercontent.com` and `api://AzureADTokenExchange`.
- **`AADSTS700016: Application with identifier '…' was not found in the directory '…'`**: the client ID is not the identity's client ID (the object ID was copied?), or the tenant ID is another tenant. Copy both again (step 5).
- **`AADSTS700024: Client assertion is not within its valid time range`**: the OIDC token expired between `azure/login` and the publication. Re-run the job; keep `azure/login` right before *Publish*.
- **`No subscriptions found`**: `allow-no-subscriptions: true` is missing from `azure/login`.
- **`Branch "…" is not allowed to deploy to marketplace`** (or `Tag "…"`): the run does not come from `main` or from a version tag (step 6).
- **The job waits with *Waiting for review***: required reviewers are set on the environment (step 6): approve it with *Review deployments*.
- ***Marketplace identity* fails in its first job, *Client ID and tenant ID***: the two fields of the form are empty and the variables of step 9 do not exist yet, or a value is not an ID (`00000000-0000-0000-0000-000000000000`).

Publishing (`vsce` step):

- **`Can not acquire a Microsoft Entra ID access token`**: vsce found no signed-in Azure CLI. Read the log of the `azure/login` step.
- **`InvalidAccessException`** after a successful sign-in: the identity is an app registration, not a user-assigned managed identity (user reports, *not documented*). Create a managed identity (step 3) and redo steps 4 to 9 with it.
- **401**, `TF400813: The user '…' is not authorized to access this resource`: Azure DevOps does not know the identity as a member of the publisher. Run *Marketplace identity* and compare the ID with the *Members* page (step 8).
- **403**, `Access Denied: … needs the following permission(s)`: the identity is a member with a role that cannot publish. Give it **Contributor**.
- The *Members* page refuses the ID, or the publication still gets 401 although the ID is listed: the case of a publisher owned by a personal Microsoft account with a member from an Entra tenant is *not documented*. Keep the upload by hand; it can be reported in the [vsce repository](https://github.com/microsoft/vscode-vsce/issues).

The release:

- **The job *VS Code Marketplace not set up* runs instead of *Publish to the VS Code Marketplace***: `AZURE_CLIENT_ID` or `AZURE_TENANT_ID` is missing, or was created as an environment variable instead of a repository variable (step 9).
- **`The commit of v1.2.3 (…) is not on main`**: the tag was pushed on a commit that `main` does not contain. Delete the tag (`git push origin :refs/tags/v1.2.3`, then `git tag -d v1.2.3`) and merge the version into `main`: its release creates the tag.
- **`Version 1.2.3 is lower than the latest release`**: raise the version. To publish an older released version again, use *Run workflow* on its tag: its GitHub Release must exist.

#### Fallback: upload by hand

When the Marketplace is not set up, or its job failed:

1. Download the `.vsix` from the GitHub Release (*Assets*), or from the *Artifacts* of the run.
2. Open the [publisher management page](https://marketplace.visualstudio.com/manage), click `…` next to DrawMeDatabase, then *Update*, and select the `.vsix`.
3. Wait for the verification to finish, then check the new version on the extension page.

To stop the automatic publication, delete the variable `AZURE_CLIENT_ID`: the `marketplace` job is then skipped. To remove the access entirely: remove the member from the publisher, then delete the federated credentials, the identity or the whole resource group. There is no secret to revoke.

References: [Publishing Extensions (VS Code)](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [vsce README, Trusted publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing), [Configure a user-assigned managed identity to trust an external identity provider (Microsoft Learn)](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity), [azure/login](https://github.com/Azure/login), [Managing environments for deployment (GitHub)](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment), [Publishing Extensions (Open VSX)](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions), [Namespace Access (Open VSX)](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).
