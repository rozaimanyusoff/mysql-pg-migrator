import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function MappingRedirect() {
  const router = useRouter();
  useEffect(() => { void router.replace('/migration'); }, [router]);
  return null;
}
