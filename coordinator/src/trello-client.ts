import type { Logger } from "./logger.js";

const TRELLO_API_BASE = "https://api.trello.com/1";
const REQUEST_TIMEOUT_MS = 15_000;

// --- Trello API types ---

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idBoard: string;
  idList: string;
  labels: TrelloLabel[];
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
  idBoard: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
}

export interface TrelloSearchResult {
  cards: TrelloCard[];
}

// --- Client ---

export class TrelloClient {
  private readonly apiKey: string;
  private readonly token: string;

  constructor(
    private readonly log: Logger,
  ) {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;

    if (!apiKey || !token) {
      throw new Error(
        "Missing Trello credentials. Set TRELLO_API_KEY and TRELLO_TOKEN environment variables.",
      );
    }

    this.apiKey = apiKey;
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    queryParams?: Record<string, string>,
    body?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${TRELLO_API_BASE}${path}`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("token", this.token);

    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
      }
    }

    const options: RequestInit = {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    if (body && (method === "PUT" || method === "POST")) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    this.log.debug("Trello API request", { method, path, queryParams });

    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(
        `Trello API error: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Search for cards by name across boards.
   */
  async searchCards(
    query: string,
    options?: { boardId?: string },
  ): Promise<TrelloCard[]> {
    const params: Record<string, string> = {
      query,
      modelTypes: "cards",
      cards_limit: "10",
      card_fields: "id,name,desc,url,shortUrl,idBoard,idList,labels",
    };

    if (options?.boardId) {
      params.idBoards = options.boardId;
    }

    const result = await this.request<TrelloSearchResult>(
      "GET",
      "/search",
      params,
    );
    return result.cards ?? [];
  }

  /**
   * Get a card by ID or shortLink.
   */
  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>("GET", `/cards/${cardId}`, {
      fields: "id,name,desc,url,shortUrl,idBoard,idList,labels",
    });
  }

  /**
   * Move a card to a different list.
   */
  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.request<TrelloCard>("PUT", `/cards/${cardId}`, {
      idList: listId,
    });
  }

  /**
   * Update a card's description.
   */
  async updateCardDescription(
    cardId: string,
    description: string,
  ): Promise<void> {
    await this.request<TrelloCard>("PUT", `/cards/${cardId}`, {
      desc: description,
    });
  }

  /**
   * Get all lists on a board.
   */
  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>("GET", `/boards/${boardId}/lists`, {
      filter: "open",
    });
  }

  /**
   * Get board details.
   */
  async getBoard(boardId: string): Promise<TrelloBoard> {
    return this.request<TrelloBoard>("GET", `/boards/${boardId}`, {
      fields: "id,name,url",
    });
  }

  /**
   * Extract card shortLink from a Trello URL.
   * URLs look like: https://trello.com/c/{shortLink}/{slug}
   */
  static extractCardIdFromUrl(url: string): string | null {
    const match = url.match(/trello\.com\/c\/([a-zA-Z0-9]+)/);
    return match?.[1] ?? null;
  }
}
