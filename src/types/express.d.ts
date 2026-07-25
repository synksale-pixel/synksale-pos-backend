import { UserDocument } from "../models/user.model";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      user?: UserDocument;
    }
  }
}

export {};
