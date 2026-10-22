// The package ships types, but its "exports" map hides them from Node16 resolution.
declare module "mongodb-connection-string-url" {
  export class ConnectionString {
    constructor(uri: string, options?: { looseValidation?: boolean });
    hosts: string[];
    username: string;
    password: string;
    pathname: string;
    readonly searchParams: URLSearchParams;
    readonly isSRV: boolean;
    toString(): string;
  }
}
