# Privacy Policy

**Extension:** Usage Overlay for Claude (repository: Claude_Usage_Extension)
**Last updated:** 21 November 2026

This is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic.

## Summary

The extension does not collect, sell, share or transmit any of your data to me or to any third party. Everything it does happens inside your own browser.

## What the extension does

On pages at `https://claude.ai/*`, the extension shows a small strip with your Claude session and weekly usage limits. To do this it:

- asks claude.ai for your usage numbers (a request to claude.ai itself, using your existing signed-in session, the same data the Usage page in Claude's settings shows);
- reads the `lastActiveOrg` cookie on claude.ai to know which organization's usage to request, and falls back to asking claude.ai for your organization list if that cookie is missing;
- looks at the layout of the page (for example, where the header and message box sit, and whether the "Stop" button is showing) so it can position the strip and notice when a reply has finished.

## What the extension does not do

- It does not read, store or transmit the text of your messages, Claude's replies, or any of your chats.
- It does not send anything to any server other than claude.ai, and it has no servers of its own.
- It does not use analytics, advertising, tracking, or any third-party service.
- It does not run on any website other than claude.ai.

## What is stored

The extension stores one setting in your browser's local extension storage: whether the strip is currently hidden or shown. It stays on your device. Your usage numbers are held in memory while the page is open and are not saved.

## Permissions

- **storage:** to remember whether the strip is hidden or shown.
- **Access to `https://claude.ai/*`:** to display the strip on claude.ai and to request your own usage numbers from claude.ai.

## Your choices

You can hide the strip with the toolbar icon, or remove the extension at any time from `chrome://extensions`. Removing it deletes the stored setting.

## Changes

If this policy changes, the updated version will be posted here with a new date.

## Contact

Questions: open an issue at https://github.com/thedanielpj/Claude_Usage_Extension/issues
