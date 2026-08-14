/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Default web behavior for built-in models. Interpolated into the base prompt's
 * `# Tools` section only for the tools actually present in the toolset, so a
 * session is never told it has one it does not.
 *
 * The two are described separately because a deployment can serve either alone:
 * the backend configures a search provider and a page fetcher independently, and
 * naming `fetch_content` to a model that has no such tool invites a call that
 * cannot be dispatched.
 */
export const webToolsPrompt = ({ search, fetchContent }: { search: boolean; fetchContent: boolean }): string => {
  if (search && fetchContent) {
    return `Web lookups use the \`search\` and \`fetch_content\` tools.
Quick questions: run at most one search and answer from its snippets. Fetch a page only when the snippets are insufficient.
Deep dives, research requests, or comprehensive reports: break the question into sub-questions, search each from multiple angles, fetch the pages needed for evidence, and synthesize the findings.`
  }
  if (search) {
    return `Web lookups use the \`search\` tool. There is no page-fetch tool available, so answer from result snippets.
Quick questions: run at most one search and answer from its snippets.
Deep dives, research requests, or comprehensive reports: break the question into sub-questions and search each from multiple angles, then synthesize the findings from the snippets.`
  }
  if (fetchContent) {
    return `Page contents come from the \`fetch_content\` tool, for a URL you already have. There is no web search tool available, so do not claim you searched.`
  }
  return ''
}
