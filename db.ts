import { MongoClient } from "mongodb";

const client = new MongoClient(
  Deno.env.get("MONGO_URI") || "mongodb://localhost:27017",
);
const db = client.db(Deno.env.get("MONGO_DB") || "otomatik");

export const movieDetailCollection = db.collection("movie_detail");
