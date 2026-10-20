import {
  addCollabCheckEvidence,
  convertCollabIdea,
  createCollabOpenQuestion,
  getWorkpadPlan,
  createCollabArtifact,
  createCollabCheck,
  createCollabCriterion,
  createCollabDelivery,
  createCollabIdea,
  getCollabArtifactContent,
  getCollabProjectInsights,
  getCollabDeliveryReview,
  listCollabArtifacts,
  listCollabChecks,
  listCollabCriteria,
  listCollabCriterionHistory,
  listCollabDeliveries,
  listCollabIdeas,
  listCollabOpenItems,
  listCollabOpenQuestionHistory,
  listCollabOpenQuestions,
  listCollabSummaries,
  listCollabTaskDecisions,
  queueCollabSummary,
  recordCollabTaskDecision,
  recordCollabUsage,
  resolveCollabOpenQuestion,
  publishCollabArtifact,
  updateCollabCheck,
  updateCollabCriterion,
} from '@fluent-flow/db/dist/collaboration/evidence.js';

/**
 * A4 evidence routes (B-owned slice): acceptance criteria, checks + evidence,
 * artifacts, ideas, summaries, usage and delivery. Mounted by the main collab
 * router behind requireActor; services re-check principal/capability, so the
 * routes stay thin envelope mapping. Deep import until the index re-export is
 * registered (coordinated with A).
 */
export function registerEvidenceRoutes(router) {
  router.get('/tasks/:id/criteria', async (req, res, next) => {
    try {
      const data = await listCollabCriteria({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/criteria', async (req, res, next) => {
    try {
      const criterion = await createCollabCriterion({
        actor: req.collabActor,
        taskId: req.params.id,
        text: req.body?.text,
      });
      res.status(201).json({ data: criterion });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/tasks/:id/criteria/:criterionId', async (req, res, next) => {
    try {
      const criterion = await updateCollabCriterion({
        actor: req.collabActor,
        taskId: req.params.id,
        criterionId: req.params.criterionId,
        expectedVersion: req.body?.expectedVersion,
        text: req.body?.text,
        state: req.body?.state,
        reason: req.body?.reason,
      });
      res.json({ data: criterion });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/criteria/:criterionId/history', async (req, res, next) => {
    try {
      const data = await listCollabCriterionHistory({
        actor: req.collabActor,
        taskId: req.params.id,
        criterionId: req.params.criterionId,
      });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/checks', async (req, res, next) => {
    try {
      const data = await listCollabChecks({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/checks', async (req, res, next) => {
    try {
      const check = await createCollabCheck({
        actor: req.collabActor,
        taskId: req.params.id,
        name: req.body?.name,
        command: req.body?.command,
        visibility: req.body?.visibility,
      });
      res.status(201).json({ data: check });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/tasks/:id/checks/:checkId', async (req, res, next) => {
    try {
      const check = await updateCollabCheck({
        actor: req.collabActor,
        taskId: req.params.id,
        checkId: req.params.checkId,
        expectedVersion: req.body?.expectedVersion,
        name: req.body?.name,
        command: req.body?.command,
        visibility: req.body?.visibility,
      });
      res.json({ data: check });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/checks/:checkId/evidence', async (req, res, next) => {
    try {
      const evidence = await addCollabCheckEvidence({
        actor: req.collabActor,
        taskId: req.params.id,
        checkId: req.params.checkId,
        status: req.body?.status,
        exitCode: req.body?.exitCode,
        commit: req.body?.commit,
        dirty: req.body?.dirty,
        runId: req.body?.runId,
        sessionId: req.body?.sessionId,
        outputArtifactId: req.body?.outputArtifactId,
        provenance: req.body?.provenance,
      });
      res.status(201).json({ data: evidence });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/artifacts', async (req, res, next) => {
    try {
      const data = await listCollabArtifacts({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/artifacts', async (req, res, next) => {
    try {
      const artifact = await createCollabArtifact({
        actor: req.collabActor,
        taskId: req.params.id,
        runId: req.body?.runId ?? null,
        sessionId: req.body?.sessionId ?? null,
        direction: req.body?.direction,
        kind: req.body?.kind,
        name: req.body?.name,
        visibility: req.body?.visibility,
        mediaType: req.body?.mediaType,
        reference: req.body?.reference,
        content: req.body?.content,
      });
      res.status(201).json({ data: artifact });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/artifacts/:artifactId/publication', async (req,res,next) => {
    try {res.json({data:await publishCollabArtifact({actor:req.collabActor,taskId:req.params.id,artifactId:req.params.artifactId,expectedVersion:req.body?.expectedVersion,visibility:req.body?.visibility})});} catch(err) {next(err);}
  });

  const sendArtifactContent = (req, res, result) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if ('state' in result) {
      res.status(result.state === 'unavailable' ? 200 : 202).json({ data: result });
      return;
    }
    if (req.query.raw === '1') {
      const mediaType=result.mediaType??'text/plain';
      const inline=['text/plain','image/png','image/jpeg','image/webp','image/gif','application/pdf'].includes(mediaType);
      res.set('Content-Type',mediaType);
      res.set('Content-Security-Policy',"default-src 'none'; sandbox");
      // ASCII fallback prevents header injection; the full name remains in metadata.
      const name=result.name.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,150)||'artifact';
      res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename="${name}"`);
      res.send(result.contentBase64 ? Buffer.from(result.contentBase64,'base64') : result.content);
      return;
    }
    res.json({ data: result });
  };

  router.get('/tasks/:id/artifacts/:artifactId/content', async (req, res, next) => {
    try { sendArtifactContent(req,res,await getCollabArtifactContent({actor:req.collabActor,taskId:req.params.id,artifactId:req.params.artifactId})); } catch(err) { next(err); }
  });
  router.get('/artifacts/:artifactId/content', async (req,res,next) => {
    try {
      const {getCollabArtifactContentById}=await import('@fluent-flow/db/dist/collaboration/evidence.js');
      sendArtifactContent(req,res,await getCollabArtifactContentById({actor:req.collabActor,artifactId:req.params.artifactId}));
    } catch(err) { next(err); }
  });

  router.get('/tasks/:id/ideas', async (req, res, next) => {
    try {
      const data = await listCollabIdeas({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/ideas', async (req, res, next) => {
    try {
      const idea = await createCollabIdea({
        actor: req.collabActor,
        taskId: req.params.id,
        runId: req.body?.runId ?? null,
        sessionId: req.body?.sessionId ?? null,
        title: req.body?.title,
        body: req.body?.body,
        visibility: req.body?.visibility,
      });
      res.status(201).json({ data: idea });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ideas/:id/conversions', async (req, res, next) => {
    try {
      const result = await convertCollabIdea({
        actor: req.collabActor,
        taskId: req.body?.taskId,
        ideaId: req.params.id,
        kind: req.body?.kind,
        expectedVersion: req.body?.expectedVersion,
        title: req.body?.title,
        sessionId: req.body?.sessionId,
        idempotencyKey: req.headers['idempotency-key'],
      });
      res.status(result.replay ? 200 : 201).json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/runs/:id/summaries', async (req, res, next) => {
    try {
      const data = await listCollabSummaries({
        actor: req.collabActor,
        taskId: req.query.taskId,
        runId: req.params.id,
      });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/runs/:id/summaries', async (req,res,next) => {
    try {
      const command=await queueCollabSummary({actor:req.collabActor,runId:req.params.id,idempotencyKey:req.headers['idempotency-key']});
      res.status(202).json({data:command});
    } catch(err) {next(err);}
  });

  router.get('/projects/:id/insights', async (req, res, next) => {
    try {
      const data = await getCollabProjectInsights({
        actor: req.collabActor,
        projectId: req.params.id,
        from: new Date(String(req.query.from)),
        to: new Date(String(req.query.to)),
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/deliveries', async (req, res, next) => {
    try {
      const data = await listCollabDeliveries({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tasks/:id/deliveries', async (req, res, next) => {
    try {
      const delivery = await createCollabDelivery({
        actor: req.collabActor,
        taskId: req.params.id,
        expectedVersion: req.body?.expectedVersion,
        note: req.body?.note,
        artifactIds: req.body?.artifactIds,
        checkEvidenceIds: req.body?.checkEvidenceIds,
      });
      res.status(201).json({ data: delivery });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/open-items', async (req, res, next) => {
    try {
      const data = await listCollabOpenItems({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/delivery-review', async (req, res, next) => {
    try { res.json({ data: await getCollabDeliveryReview({ actor: req.collabActor, taskId: req.params.id }) }); } catch (err) { next(err); }
  });

  router.post('/tasks/:id/decisions', async (req, res, next) => {
    try {
      const result = await recordCollabTaskDecision({
        actor: req.collabActor,
        taskId: req.params.id,
        decision: req.body?.decision,
        note: req.body?.note,
        acknowledgedOpenItemIds: req.body?.acknowledgedOpenItemIds,
        reviewSnapshot: req.body?.reviewSnapshot,
        expectedVersion: req.body?.expectedVersion,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id/decisions', async (req, res, next) => {
    try {
      const result = await listCollabTaskDecisions({ actor: req.collabActor, taskId: req.params.id, limit: req.query.limit, cursor: req.query.cursor });
      res.json({ data: result.decisions, nextCursor: result.nextCursor });
    } catch (err) { next(err); }
  });

  router.get('/tasks/:id/plan', async (req, res, next) => {
    try {
      const data = await getWorkpadPlan({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data });
    } catch (err) { next(err); }
  });

  router.post('/tasks/:id/plan', async (req, res, next) => {
    try {
      const { editWorkpadPlan } = await import('@fluent-flow/db/dist/collaboration/evidence.js');
      const data = await editWorkpadPlan({ actor: req.collabActor, taskId: req.params.id, items: req.body?.items });
      res.status(201).json({ data });
    } catch (err) { next(err); }
  });

  router.get('/tasks/:id/questions', async (req, res, next) => {
    try {
      const data = await listCollabOpenQuestions({ actor: req.collabActor, taskId: req.params.id });
      res.json({ data, nextCursor: null });
    } catch (err) { next(err); }
  });

  router.post('/tasks/:id/questions', async (req, res, next) => {
    try {
      const question = await createCollabOpenQuestion({
        actor: req.collabActor, taskId: req.params.id, text: req.body?.text,
      });
      res.status(201).json({ data: question });
    } catch (err) { next(err); }
  });

  router.post('/tasks/:id/questions/:questionId/resolve', async (req, res, next) => {
    try {
      const question = await resolveCollabOpenQuestion({
        actor: req.collabActor, taskId: req.params.id, questionId: req.params.questionId,
        answer: req.body?.answer, expectedVersion: req.body?.expectedVersion,
      });
      res.json({ data: question });
    } catch (err) { next(err); }
  });

  router.get('/tasks/:id/questions/:questionId/history', async (req, res, next) => {
    try {
      const data = await listCollabOpenQuestionHistory({
        actor: req.collabActor, taskId: req.params.id, questionId: req.params.questionId,
      });
      res.json({ data, nextCursor: null });
    } catch (err) { next(err); }
  });
}
