/**
 * GitHub GraphQL API client — primarily for GitHub Projects v2 operations.
 */
import logger from '../logger.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GRAPHQL_URL = 'https://api.github.com/graphql';

// Cache project field IDs: projectId -> { statusFieldId, optionMap, cachedAt }
const projectFieldCache = new Map();
const PROJECT_FIELD_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Execute a GraphQL query/mutation.
 * @param {string} query
 * @param {object} [variables]
 * @returns {Promise<object>} GraphQL data
 */
async function graphqlRequest(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub GraphQL HTTP error: ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  const result = await response.json();

  if (result.errors?.length > 0) {
    const err = new Error(`GitHub GraphQL errors: ${result.errors.map((e) => e.message).join('; ')}`);
    err.errors = result.errors;
    throw err;
  }

  return result.data;
}

/**
 * Fetch and cache Status field info for a project.
 * @param {string} projectId - Node ID of the project (PVT_xxx)
 * @returns {{ statusFieldId: string, optionMap: Map<string, string> }}
 */
async function getProjectFields(projectId) {
  const cached = projectFieldCache.get(projectId);
  if (cached && Date.now() - cached.cachedAt < PROJECT_FIELD_CACHE_TTL_MS) {
    return { statusFieldId: cached.statusFieldId, optionMap: cached.optionMap };
  }

  const data = await graphqlRequest(`
    query GetProjectFields($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `, { projectId });

  const fields = data?.node?.fields?.nodes ?? [];
  const statusField = fields.find((f) => f?.name === 'Status');

  if (!statusField) {
    throw new Error(`No "Status" field found in project ${projectId}`);
  }

  const optionMap = new Map();
  for (const opt of statusField.options ?? []) {
    optionMap.set(opt.name, opt.id);
  }

  projectFieldCache.set(projectId, {
    statusFieldId: statusField.id,
    optionMap,
    cachedAt: Date.now(),
  });

  return { statusFieldId: statusField.id, optionMap };
}

/**
 * Update the Status field of a project item.
 * @param {string} projectId - Project node ID
 * @param {string} itemNodeId - Item node ID
 * @param {string} targetState - Target state name (must match a Status option)
 */
export async function moveProjectItem(projectId, itemNodeId, targetState) {
  const { statusFieldId, optionMap } = await getProjectFields(projectId);

  const optionId = optionMap.get(targetState);
  if (!optionId) {
    throw new Error(`State "${targetState}" not found in project ${projectId}. Available: ${[...optionMap.keys()].join(', ')}`);
  }

  await graphqlRequest(`
    mutation UpdateProjectItemField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `, {
    projectId,
    itemId: itemNodeId,
    fieldId: statusFieldId,
    optionId,
  });

  logger.info({ msg: 'Moved project item', projectId, itemNodeId, targetState });
}

/**
 * Get the Status option name for a project item.
 * @param {string} projectId
 * @param {string} itemNodeId
 * @returns {string|null} Current status name
 */
export async function getProjectItemStatus(projectId, itemNodeId) {
  const { statusFieldId } = await getProjectFields(projectId);

  const data = await graphqlRequest(`
    query GetItemStatus($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    id
                  }
                }
                name
              }
            }
          }
        }
      }
    }
  `, { itemId: itemNodeId });

  const fieldValues = data?.node?.fieldValues?.nodes ?? [];
  const statusValue = fieldValues.find((v) => v?.field?.id === statusFieldId);
  return statusValue?.name ?? null;
}

/**
 * Find the project item node ID for an issue.
 * @param {string} projectId
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {string|null} Item node ID
 */
export async function findProjectItem(projectId, owner, repo, issueNumber) {
  // Query project items and find the one matching this issue
  // Uses cursor-based pagination to find the item
  let cursor = null;
  do {
    const data = await graphqlRequest(`
      query FindProjectItem($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 50, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                content {
                  ... on Issue {
                    number
                    repository {
                      nameWithOwner
                    }
                  }
                  ... on PullRequest {
                    number
                    repository {
                      nameWithOwner
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId, cursor });

    const items = data?.node?.items;
    if (!items) break;

    const repoFullName = `${owner}/${repo}`;
    const found = items.nodes?.find(
      (item) =>
        item?.content?.number === issueNumber &&
        item?.content?.repository?.nameWithOwner === repoFullName
    );
    if (found) return found.id;

    if (!items.pageInfo?.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  } while (cursor);

  return null;
}

/**
 * Enable auto-merge on a pull request via GraphQL.
 * @param {string} prNodeId - Node ID of the PR
 * @param {string} [mergeMethod='SQUASH'] - SQUASH | MERGE | REBASE
 */
export async function enablePullRequestAutoMerge(prNodeId, mergeMethod = 'SQUASH') {
  await graphqlRequest(`
    mutation EnableAutoMerge($prId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $prId
        mergeMethod: $mergeMethod
      }) {
        pullRequest {
          id
          autoMergeRequest {
            enabledAt
          }
        }
      }
    }
  `, { prId: prNodeId, mergeMethod });

  logger.info({ msg: 'Enabled auto-merge', prNodeId, mergeMethod });
}

/**
 * Get the node ID of a PR.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {string} PR node ID
 */
export async function getPRNodeId(owner, repo, prNumber) {
  const data = await graphqlRequest(`
    query GetPRNodeId($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
        }
      }
    }
  `, { owner, repo, number: prNumber });

  return data?.repository?.pullRequest?.id;
}

/**
 * Invalidate project field cache for a project.
 */
export function invalidateProjectCache(projectId) {
  projectFieldCache.delete(projectId);
}
