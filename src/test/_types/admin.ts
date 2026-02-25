import { User } from "../test2/_types/user";

export interface Admin extends User {
  role: 'admin';
}