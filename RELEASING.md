# Releasing

1. Set `version` in `package.json` (and `plugin/herdr-plugin.toml` when the plugin changed), and turn the
   CHANGELOG's "Unreleased" section into that version.
2. Commit, push, then tag: `git tag -a v0.2.1 -m "Herdr Cockpit v0.2.1" && git push origin v0.2.1`.
3. The **Release** workflow tests and packages the extension, creates the GitHub release with
   `herdr-cockpit.vsix` (the Herdr plugin downloads that name), and publishes to the stores that are set up below.
   Re-running it is safe: the release's files are replaced and stores skip versions they already have.

Without store publishing set up, upload the `.vsix` from the release by hand: the Marketplace's
publisher page (**⋯ → Update**), and `npx ovsx publish herdr-cockpit.vsix -p <token>` for Open VSX.

## VS Code Marketplace: Microsoft Entra ID (one-time setup)

The Marketplace no longer takes personal access tokens after 2026-12-01. The workflow signs in as an Entra ID
app registration instead: GitHub hands the job a short-lived identity token, and Entra trusts it only for this
repository's `marketplace` environment. No secret is stored anywhere, and no Azure subscription is needed.

1. **App registration.** In the Azure portal (signed in with the account that owns the Marketplace
   publisher): **Microsoft Entra ID → App registrations → New registration**. Name: `herdr-cockpit-publisher`;
   supported account types: **this organizational directory only**; no redirect URI. **Register**, then copy
   the **Application (client) ID** and the **Directory (tenant) ID** from its Overview page.
2. **Federated credential.** In the app: **Certificates & secrets → Federated credentials → Add credential**.
   Scenario: **GitHub Actions deploying Azure resources**. Organization `sriharirao92`, repository
   `vscode-herdr-cockpit`, entity type **Environment**, environment name `marketplace`. Name it `github-marketplace`
   and **Add**. (Its subject is `repo:sriharirao92/vscode-herdr-cockpit:environment:marketplace`.)
3. **GitHub environment and variables.** In the repository: **Settings → Environments → New environment**
   `marketplace`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the
   branch `main` and the tag pattern `v*`, so nothing else can use it. Then **Settings → Secrets and variables
   → Actions → Variables → New repository variable**: `AZURE_CLIENT_ID` (the client ID) and
   `AZURE_TENANT_ID` (the tenant ID). These are identifiers, not secrets.
4. **The app's Azure DevOps ID.** Run **Actions → Marketplace identity → Run workflow** (on `main`). Its
   summary shows the app's Azure DevOps profile ID.
5. **Add the app to the publisher.** On https://marketplace.visualstudio.com/manage/publishers/sriharirao,
   open **Members → Add**, paste that ID, and give it the **Contributor** role.

The next tag publishes to the Marketplace. To publish an existing tag, re-run its Release workflow.

## Open VSX (Cursor, Kiro, Positron): Trusted Publishing (one-time setup)

Open VSX's Trusted Publishing works like the Marketplace setup above: the workflow trades its GitHub OIDC token
for a 5-minute token that can publish only this extension, so nothing is stored. It needs the namespace to have an
owner and the extension to exist, so the first version is published by hand.

1. **Account.** Sign in at https://open-vsx.org with GitHub, link an Eclipse account and sign the Publisher
   Agreement (on the profile page). The `sriharirao` namespace already exists.
2. **First version, by hand.** **Settings → Access Tokens → Generate new token**, then in your own terminal:
   `npx ovsx publish herdr-cockpit-0.2.0.vsix -p <token>` (the `.vsix` is on the GitHub release). Afterwards
   delete the token (**Delete all**): it isn't needed again.
3. **Claim the namespace.** Open a "claim namespace ownership" issue at
   https://github.com/EclipseFdn/open-vsx.org/issues/new/choose for `sriharirao`, linking this repository.
   Until an owner is set, the namespace (and the extension) show as unverified. Ownership is required for step 4.
4. **Trusted publisher.** Once you're the owner: **Settings → Trusted Publishers**, namespace `sriharirao`,
   extension `herdr-cockpit`, provider **GitHub Actions**: owner `sriharirao92`, repository
   `vscode-herdr-cockpit`, workflow filename `release.yml`, no environment.
5. **Turn it on.** In this repository: **Settings → Secrets and variables → Actions → Variables → New repository
   variable** `OVSX_TRUSTED_PUBLISHING` = `true`.

Without step 5 the workflow falls back to an `OVSX_PAT` secret if there is one, and otherwise skips Open VSX.
