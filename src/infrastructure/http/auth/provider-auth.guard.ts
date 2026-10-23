import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import { AppLogger } from '../../../application/ports/logger';
import { ConfigPort } from '../../config/config';

export interface ProviderIdentity {
  providerId: string;
  subject: string;
}

export type AuthenticatedRequest = Request & { provider?: ProviderIdentity };

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * Ponto de extensão da autenticação (ver ARCHITECTURE.md, seção "Autenticação").
 *
 * AUTH_MODE=none → passa tudo (dev/testes).
 * AUTH_MODE=oidc → exige `Authorization: Bearer <JWT>` emitido pelo IdP (Keycloak,
 *   Zitadel...). Validamos assinatura via JWKS, issuer e audience, e extraímos o
 *   providerId de uma claim configurável (Keycloak: `azp` = client id). O
 *   controller de wagering ainda confere que o providerId do payload bate com o
 *   do token — o token diz quem é, o domínio decide o que pode.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  private jwks: Jwks | null = null;

  constructor(
    private readonly config: ConfigPort,
    private readonly logger: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const cfg = this.config.values;
    if (cfg.AUTH_MODE === 'none') {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new HttpException({ code: 'UNAUTHORIZED', message: 'missing bearer token' }, HttpStatus.UNAUTHORIZED);
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.getJwks(), {
        issuer: cfg.AUTH_ISSUER!,
        ...(cfg.AUTH_AUDIENCE ? { audience: cfg.AUTH_AUDIENCE } : {}),
      });
      payload = result.payload;
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, 'token rejected');
      throw new HttpException({ code: 'UNAUTHORIZED', message: 'invalid token' }, HttpStatus.UNAUTHORIZED);
    }

    const providerId = payload[cfg.AUTH_PROVIDER_CLAIM];
    if (typeof providerId !== 'string' || !providerId) {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: `token has no "${cfg.AUTH_PROVIDER_CLAIM}" claim` },
        HttpStatus.UNAUTHORIZED,
      );
    }
    request.provider = { providerId, subject: payload.sub ?? providerId };
    return true;
  }

  private getJwks(): Jwks {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(this.config.values.AUTH_JWKS_URL!));
    }
    return this.jwks;
  }
}

/** Token presente e providerId do payload diferente do token → 403. */
export function assertProviderMatches(request: AuthenticatedRequest, providerId: string): void {
  if (request.provider && request.provider.providerId !== providerId) {
    throw new HttpException(
      { code: 'PROVIDER_MISMATCH', message: 'providerId does not match the authenticated provider' },
      HttpStatus.FORBIDDEN,
    );
  }
}
