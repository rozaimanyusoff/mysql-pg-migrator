import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function DbSetupRedirect() {
  const router = useRouter();
  useEffect(() => { void router.replace('/schema-designer'); }, [router]);
  return null;
}
