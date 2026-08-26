import { Router } from 'express';
import { authenticate, requireAuth } from '../../common/auth-middleware';
import { asyncHandler, parseOrThrow } from '../../common/http';
import { CreateFeedbackSchema } from './feedback.dto';
import { createFeedback } from './feedback.service';

/** Feedback route (§6.2), mounted at /v1/feedback. Authenticated. */
export const feedbackRouter = Router();
feedbackRouter.use(authenticate);

// POST /v1/feedback — record outcome/ground-truth for a recommendation.
feedbackRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(CreateFeedbackSchema, req.body);
    res.status(201).json({ feedback: await createFeedback(requireAuth(req), input) });
  }),
);
