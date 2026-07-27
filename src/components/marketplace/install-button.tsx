'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

export function InstallTemplateButton({
  templateId,
  className,
}: {
  templateId: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      size="sm"
      variant="primary"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const response = await fetch(`/api/templates/${templateId}/install`, {
            method: 'POST',
          });
          const data = (await response.json()) as { workflow?: { id: string } };
          if (data.workflow) router.push(`/workflows/${data.workflow.id}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Download />}
      Install
    </Button>
  );
}
