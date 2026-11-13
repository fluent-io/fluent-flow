'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { TaskDetailPage } from './task-detail';
export function TaskDrawer({taskId,claimId,onClose,onSelectClaim}:{taskId:string|null;claimId:number|null;onClose:()=>void;onSelectClaim:(id:number|null)=>void}) {
 return <Dialog.Root open={taskId!==null} onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal>
  <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25"/>
  <Dialog.Content aria-describedby="task-drawer-description" onCloseAutoFocus={event=>{
   event.preventDefault();
   const card=taskId?document.querySelector<HTMLElement>(`[data-task-link="${taskId}"]`):null;
   (card??document.getElementById('board-heading'))?.focus({preventScroll:true});
  }} className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-[-12px_0_40px_-12px_rgba(0,0,0,0.35)] outline-none sm:w-[510px] sm:max-w-[calc(100vw-4rem)]">
   <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
    <Dialog.Title className="text-xs font-medium text-muted-foreground">Task details</Dialog.Title>
    <Dialog.Description id="task-drawer-description" className="sr-only">Task context, agent sessions, and discussion. Closing does not end a session.</Dialog.Description>
    <Dialog.Close className="flex h-9 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"><span className="sm:sr-only">Close task</span><X aria-hidden className="h-4 w-4"/></Dialog.Close>
   </div>
   <div className={claimId===null?'min-h-0 flex-1 overflow-y-auto [overflow-wrap:anywhere]':'min-h-0 flex-1 overflow-hidden'}>
    {taskId?<TaskDetailPage key={taskId} taskId={taskId} selectedClaimId={claimId} onSelectClaim={onSelectClaim}/>:null}
   </div>
  </Dialog.Content>
 </Dialog.Portal></Dialog.Root>;
}
