/**
 * Authentication middleware for the DM relay service.
 *
 * Extracts sender authentication data from the request body and verifies
 * the Stellar signature. On success, attaches `req.stellarAddress`.
 * Should only be mounted on routes that require message authentication.
 */

import { NextFunction, Request, Response } from "express";
import { AuthService, AuthError } from "../auth";
import { SendMessageSchema } from "../validation";
import { ZodError } from "zod";

export function messageAuthMiddleware(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const messageData = SendMessageSchema.parse(req.body);

      authService.verifyMessageAuth({
        sender: messageData.sender,
        to: messageData.recipient,
        nonce: messageData.message_index,
        timestamp: messageData.timestamp,
        signature: messageData.signature,
      });

      (req as any).stellarAddress = messageData.sender;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: "Validation Error",
          message: "Invalid request data",
          details: error.errors,
          requestId: (req as any).requestId,
        });
        return;
      }

      if (error instanceof AuthError) {
        res.status(401).json({
          error: "Authentication Failed",
          message: error.message,
          requestId: (req as any).requestId,
        });
        return;
      }

      res.status(500).json({
        error: "Internal Server Error",
        message: "Authentication error",
        requestId: (req as any).requestId,
      });
    }
  };
}
