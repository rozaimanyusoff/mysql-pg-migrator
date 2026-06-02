import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function SchemaDesignerRedirect() {
  const router = useRouter();
  useEffect(() => { void router.replace('/schema-studio'); }, [router]);
  return null;
}
