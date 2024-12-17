import { Octokit } from '@octokit/rest';
import { Command } from 'commander';

interface DeveloperStats {
  login: string;
  firstCommitDate: string | null;
  firstPRDate: string | null;
}

async function checkRateLimits(authToken: string) {
  const octokit = new Octokit({ auth: authToken });
  // Let's check I'm not at risk of getting banned for API abuse
  const resp = await octokit.rateLimit.get();
  const limit = resp.headers['x-ratelimit-limit'];
  const remaining = Number.parseInt(resp.headers['x-ratelimit-remaining'] || "0");
  const used = resp.headers['x-ratelimit-used'];
  const resetTime = new Date(Number.parseInt(resp.headers['x-ratelimit-reset'] || "") * 1000);
  const secondsUntilReset = Math.floor((resetTime.getTime() - Date.now()) / 1000);
  console.log(`${remaining} requests left, used ${used}/${limit}. Reset at ${resetTime} (${secondsUntilReset}s)`)
  if (remaining === 0) {
    throw Error("Rate limit exceeded");
  }

}

/**
 * We can look up the join date to the org where the customer is using Github Enterprise
 * 
 * @param enterprise 
 * @param authToken 
 */
async function getMemberAddDates(
  enterprise: string,
  authToken: string
): Promise<any[]> {
  const octokit = new Octokit({ auth: authToken });

  const response = await octokit.request(`GET /enterprises/${enterprise}/audit-log`, {
    phrase: "action:org.add_member",
    include: "web",
    // enterprise: 'ENTERPRISE',
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  console.log(response.data);
  return response.data;
}

async function getDeveloperStats(
  orgName: string,
  authToken: string
): Promise<DeveloperStats[]> {
  const octokit = new Octokit({ auth: authToken });
  const stats: DeveloperStats[] = [];

  try {

    // Get all members of the organization
    const { data: members } = await octokit.orgs.listMembers({
      org: orgName,
      per_page: 100,
    });

    // Get all repositories in the organization
    const { data: repos } = await octokit.repos.listForOrg({
      org: orgName,
      per_page: 100,
    });

    for (const member of members) {
      console.log(member);
      let firstCommitDate: string | null = null;
      let firstPRDate: string | null = null;

      // Search for first commit
      for (const repo of repos) {
        try {
          const { data: commits } = await octokit.repos.listCommits({
            owner: orgName,
            repo: repo.name,
            author: member.login,
            per_page: 1,
            order: 'asc',
          });

          if (commits.length > 0) {
            const commitDate = commits[0].commit.author?.date;
            if (commitDate && (!firstCommitDate || commitDate < firstCommitDate)) {
              firstCommitDate = commitDate;
            }
          }
        } catch (error) {
          console.warn(`Error fetching commits for ${repo.name}: ${error}`);
        }
      }

      // Search for first PR
      try {
        // Use more specific search query and add state to filter only merged PRs
        const { data: pulls } = await octokit.search.issuesAndPullRequests({
          q: `author:${member.login} type:pr org:${orgName} is:merged`,
          sort: 'created',
          order: 'asc',
          per_page: 1,
          headers: {
            'If-None-Match': '', // Bypass cache to avoid stale results
            'Accept': 'application/vnd.github.v3+json' // Specify API version
          }
        });

        if (pulls.items.length > 0) {
          firstPRDate = pulls.items[0].created_at;
        }
      } catch (error) {
        console.warn(`Error fetching PRs for ${member.login}: ${error}`);
      }

      stats.push({
        login: member.login,
        firstCommitDate,
        firstPRDate,
      });
    }

    return stats;
  } catch (error) {
    throw new Error(`Failed to fetch developer stats: ${error}`);
  }
}

async function main() {
  const ORG_NAME = process.env.GITHUB_ORG;
  const ENTERPRISE_NAME = process.env.GITHUB_ENTERPRISE;
  const AUTH_TOKEN = process.env.GITHUB_AUTH_TOKEN;

  if (!ORG_NAME || !AUTH_TOKEN) {
    console.log('Please provide env vars GITHUB_ORG and GITHUB_AUTH_TOKEN');
    process.exit(0);
  }
  try {
    // TODO - get the right users from port (no point fetching non-users)

    const program = new Command();

    program
      .name('github-stats')
      .description('CLI to fetch GitHub organization statistics');

    program
      .command('get-member-join-dates')
      .description('Get member add dates for a GitHub enterprise')
      .action(async () => {
        await checkRateLimits(AUTH_TOKEN);
        if (!ENTERPRISE_NAME) {
          console.error('Please provide GITHUB_ENTERPRISE env var');
          process.exit(1);
        }
        const memberDates = await getMemberAddDates(ENTERPRISE_NAME, AUTH_TOKEN);
        console.table(memberDates);
        // TODO - write the data to port 
      });

    program
      .command('get-developer-stats') 
      .description('Get developer statistics for an organization')
      .action(async () => {
        await checkRateLimits(AUTH_TOKEN);
        const stats = await getDeveloperStats(ORG_NAME, AUTH_TOKEN);
        console.table(stats);
        // TODO - write the data to port 
      });

    await program.parseAsync();

  } catch (error) {
    console.error('Error:', error);
  }
}

main();