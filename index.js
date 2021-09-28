const core = require('@actions/core');
const github = require('@actions/github');
const { graphql } = require("@octokit/graphql");
const isBefore = require('date-fns/isBefore')
const sub = require('date-fns/sub')

const fetchCardsQuery = `query projectCards($owner: String!, $repo: String!, $projectName: String!, $cursor: String!) {
                           repository(owner: $owner, name: $repo) {
                             projects(search: $projectName, last: 1) {
                               edges {
                                 node {
                                   columns(first: 20) {
                                     edges {
                                       node {
                                         name
                                         cards(first: 50, after: $cursor, archivedStates: NOT_ARCHIVED) {
                                           edges {
                                             node {
                                               id
                                               updatedAt
                                             }
                                             cursor
                                           }
                                           pageInfo {
                                             endCursor
                                             hasNextPage
                                           }
                                         }
                                       }
                                     }
                                   }
                                 }
                               }
                             }
                           }
                         }`

const fetchCardsAndIssuesQuery = `query projectCards($owner: String!, $repo: String!, $projectName: String!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    projects(search: $projectName, last: 1) {
      edges {
        node {
          columns(first: 20) {
            edges {
              node {
                name
                cards(first: 50, after: $cursor, archivedStates: NOT_ARCHIVED) {
                  pageInfo {
                    endCursor
                    hasNextPage
                  }
                  edges {
                    cursor
                    node {
                      id
                      updatedAt
                      content {
                        ... on Issue {
                          id
                          number
                          title
                          url
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`

const archiveCardQuery = `mutation archiveCards($cardId: String!, $isArchived: Boolean = true) {
                             updateProjectCard(input:{projectCardId: $cardId, isArchived: $isArchived}) {
                               projectCard {
                                 id
                               }
                             }
                           }`


const closeIssueQuery = `mutation closeIssueFromCard($issueId: String!, $closeMessage: String!) {
  addComment(input: {subjectId: $issueId, body: $closeMessage}) {
    subject {
      id
    }
  }
  closeIssue(input: {issueId: $issueId}) {
    issue {
      id
    }
  }
}
`

async function fetchCards(repoOwner, repo, projectName, currentCursor, accessToken) {
  return graphql(fetchCardsAndIssuesQuery, {
    owner: repoOwner,
    repo: repo,
    projectName: projectName,
    cursor: currentCursor,
    headers: {
      authorization: `bearer ${accessToken}`,
    }
  })
}


const dateifyCard = (card) => {
  const updatedAt = new Date(card.updatedAt)
  return { id: card.id, updatedAt: updatedAt, content: card.content }
}

async function fetchCardInfo(repoOwner, repo, projectName, accessToken, columnToArchive) {
  try {
    const projectCardIdsWithDate = []
    let currentCursor = ''
    let nextPage = true

    while (nextPage) {
      let projectCards = await fetchCards(repoOwner, repo, projectName, currentCursor, accessToken)
      projectCards = projectCards.repository.projects.edges[0].node.columns.edges.find(edge => edge.node.name.toLowerCase() === columnToArchive.toLowerCase()).node.cards
      projectCardIdsWithDate.push(...projectCards.edges.flatMap(card => card.node).map(dateifyCard))

      currentCursor = projectCards.pageInfo.endCursor
      nextPage = projectCards.pageInfo.hasNextPage
    }

    return projectCardIdsWithDate
  }
  catch (e) {
    console.log('fetchCardInfo error: ', e)
    return []
  }
}

const run = async () => {
  try {
    const accessToken = core.getInput('access-token')
    const columnToArchive = core.getInput('column-to-archive')
    const repoOwner = core.getInput('repository-owner')
    const repo = core.getInput('repository')
    const projectName = core.getInput('project-name')
    const payload = JSON.stringify(github.context.payload, undefined, 2)

    const daysOld = core.getInput('days-old');
    const closingMessage = core.getInput("closing-message") || "Issue automatically closed due to inactivity in project board.";

    const cutoffDate = sub(new Date(), { days: daysOld })

    console.log(`Archiving all cards that have been untouched for ${daysOld} days from column ${columnToArchive}!`);

    // console.log(`The event payload: ${payload}`);

    const projectCardIdsWithDate = await fetchCardInfo(repoOwner, repo, projectName, accessToken, columnToArchive)

    console.log('project cards: ', projectCardIdsWithDate);

    // Filter by updated at date
    const cardIdsToArchive = projectCardIdsWithDate
      .filter(card => isBefore(card.updatedAt, cutoffDate))
      .map(node => { return { cardId: node.id, issueId: node.content ? node.content.id : null } })

    // Archive those - https://docs.github.com/en/free-pro-team@latest/rest/reference/projects#update-an-existing-project-card

    console.log(`Archiving ${cardIdsToArchive.length} cards`)

    cardIdsToArchive.forEach(async (card) => {
      try {
        await graphql(archiveCardQuery, {
          cardId: card.cardId,
          headers: {
            authorization: `bearer ${accessToken}`,
          },
        })
        await graphql(closeIssueQuery, {
          issueId: card.issueId,
          closeMessage: closingMessage,
          headers: {
            authorization: `bearer ${accessToken}`,
          },
        })
      }
      catch (e) {
        console.log('archiveCard error: ', e)
        return false
      }
    });

  } catch (error) {
    core.setFailed(error.message);
  }

}

run()
