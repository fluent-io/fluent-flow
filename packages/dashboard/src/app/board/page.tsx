import { Suspense } from 'react';
import { BoardView } from '@/components/collab/board-view';

export default function BoardPage() {
  return (
    <Suspense>
      <BoardView />
    </Suspense>
  );
}
