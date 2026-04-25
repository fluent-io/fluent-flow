import { getServerSession } from 'next-auth';
import { listRepos } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { RepoCard } from '@/components/repos/repo-card';

export default async function ReposPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds, isSuperadmin } = getOrgScope(session);
  const repos = await listRepos(orgIds, isSuperadmin);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Repositories</h1>
        <p className="text-sm text-muted-foreground">Connect GitHub repos and start workflows</p>
      </div>
      {repos.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-muted-foreground">No repositories yet — install the GitHub App to get started</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {repos.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}
