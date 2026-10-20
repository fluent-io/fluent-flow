import {
  collabTaskSchema,
  createCollabTask,
  getCollabTask,
  listCollabTasks,
  moveCollabTask,
  updateCollabTask,
  createCollabDeliveryLink,
  listCollabDeliveryLinks,
} from '@fluent-flow/db';

/**
 * Task backlog routes. Capture has no repository/run/host prerequisite; list
 * and detail reads are actor-scoped before pagination/search.
 */
export function registerTaskRoutes(router) {
  router.get('/tasks/:id/delivery-links',async(req,res,next)=>{
    try {res.json({data:await listCollabDeliveryLinks({actor:req.collabActor,taskId:req.params.id})});}catch(err){next(err);}
  });
  router.post('/tasks/:id/delivery-links',async(req,res,next)=>{
    try {res.status(201).json({data:await createCollabDeliveryLink({actor:req.collabActor,taskId:req.params.id,repo:req.body?.repo,prNumber:req.body?.prNumber,claimId:req.body?.claimId})});}catch(err){next(err);}
  });
  router.get('/tasks', async (req, res, next) => {
    try {
      const limitParam = Number.parseInt(String(req.query.limit ?? ''), 10);
      const result = await listCollabTasks({
        actor: req.collabActor,
        projectId: req.query.projectId || undefined,
        workspaceId: req.query.workspaceId || undefined,
        status: req.query.status || undefined,
        assigneeId: req.query.assigneeId || undefined,
        q: req.query.q || undefined,
        cursor: req.query.cursor || undefined,
        limit: Number.isInteger(limitParam) ? limitParam : 50,
      });
      res.json({ data: result.tasks.map((t) => collabTaskSchema.parse(t)), nextCursor: result.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/tasks', async (req, res, next) => {
    try {
      const task = await createCollabTask({
        actor: req.collabActor,
        projectId: req.params.id,
        title: req.body?.title,
        description: req.body?.description,
        priority: req.body?.priority,
        assigneeId: req.body?.assigneeId ?? null,
      });
      res.status(201).json({ data: collabTaskSchema.parse(task) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/tasks/:id', async (req, res, next) => {
    try {
      const task = await updateCollabTask({
        actor: req.collabActor,
        taskId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        title: req.body?.title,
        description: req.body?.description,
        priority: req.body?.priority,
        assigneeId: req.body?.assigneeId,
        blockedReason: req.body?.blockedReason,
      });
      res.json({ data: collabTaskSchema.parse(task) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/moves', async (req, res, next) => {
    try {
      const result = await moveCollabTask({
        actor: req.collabActor,
        taskId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        expectedBoardVersion: req.body?.expectedBoardVersion,
        status: req.body?.status,
        beforeTaskId: req.body?.beforeTaskId ?? null,
        afterTaskId: req.body?.afterTaskId ?? null,
      });
      res.json({ data: { task: collabTaskSchema.parse(result.task), boardVersion: result.boardVersion } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id', async (req, res, next) => {
    try {
      const { task, capabilities } = await getCollabTask(req.collabActor, req.params.id);
      res.json({ data: { ...collabTaskSchema.parse(task), capabilities } });
    } catch (err) {
      next(err);
    }
  });
}
