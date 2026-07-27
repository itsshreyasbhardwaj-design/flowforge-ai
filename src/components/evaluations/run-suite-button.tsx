'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

export function RunSuiteButton({ suiteId }: { suiteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      size="sm"
      variant="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/evals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'run', suiteId }),
          });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Play />}
      {busy ? 'Running' : 'Run suite'}
    </Button>
  );
}
