import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';

export default async function Home() {
  const session = await getServerSession(authOptions);
  const isInternal = Boolean(session?.user.isSuperadmin) || typeof session?.user.id === 'number';
  redirect(isInternal ? '/agents' : '/board');
}
