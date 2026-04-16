export type AppBindings = {
  Variables: {
    userId: string;
  };
};

export type RequestStatus = "pending" | "accepted" | "rejected";

export type ConnectionRequest = {
  requestId: string;
  fromUserId: string;
  toUserId: string;
  message?: string;
  status: RequestStatus;
  createdAt: string;
  respondedAt?: string;
};

export type PostAction = "like" | "save" | "open";

export type PostInteraction = {
  likes: number;
  saves: number;
  opens: number;
  topics: string[];
  lastOpenedAt?: string;
};

export type TopicScoreMap = Record<string, number>;

export type PostInteractionMap = Record<string, PostInteraction>;
