import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function SchemaConfigRedirect() {
  const router = useRouter();
  useEffect(() => { void router.replace('/schema-explorer'); }, [router]);
  return null;
}
