import { Suspense } from 'react';
import { SettingsView } from '@/components/collab/settings-view';

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
