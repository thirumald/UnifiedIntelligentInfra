import {
  Body,
  Controller,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { API_ENV, type ApiEnv } from '../config';
import { ZodPipe } from '../common/zod.pipe';

export type Role = 'admin' | 'operator' | 'viewer' | 'device';

export interface Principal {
  sub: string;
  tenantId: string;
  roles: Role[];
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, device: 1, operator: 2, admin: 3 };

const IS_PUBLIC = 'dt:public';
const REQUIRED_ROLE = 'dt:role';

/** Route needs no token (login, health) */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Minimum role; 'device' is matched exactly (machine credentials). */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<Request & { user: Principal }>().user;
});

@Injectable()
export class TokenService {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  sign(principal: Principal): { accessToken: string; expiresIn: number } {
    const accessToken = jwt.sign({ tenantId: principal.tenantId, roles: principal.roles }, this.env.JWT_SECRET, {
      subject: principal.sub,
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
      expiresIn: this.env.JWT_TTL_SECONDS,
      algorithm: 'HS256',
    });
    return { accessToken, expiresIn: this.env.JWT_TTL_SECONDS };
  }

  verify(token: string): Principal {
    const decoded = jwt.verify(token, this.env.JWT_SECRET, {
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload & { tenantId?: string; roles?: Role[] };
    if (!decoded.sub || !decoded.tenantId) throw new UnauthorizedException('malformed token');
    return { sub: decoded.sub, tenantId: decoded.tenantId, roles: decoded.roles ?? ['viewer'] };
  }

  /** Dev-mode principal when AUTH_DISABLED=true */
  anonymous(): Principal {
    return { sub: 'anonymous', tenantId: this.env.TENANT_ID, roles: ['admin'] };
  }

  get disabled(): boolean {
    return this.env.AUTH_DISABLED;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true; // WS auth handled in the gateway
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: Principal }>();
    let principal: Principal;
    if (this.tokens.disabled) {
      principal = this.tokens.anonymous();
    } else {
      const token = extractBearer(req.headers.authorization);
      if (!token) throw new UnauthorizedException('missing bearer token');
      try {
        principal = this.tokens.verify(token);
      } catch {
        throw new UnauthorizedException('invalid or expired token');
      }
    }
    req.user = principal;

    const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, handlers);
    if (!required) return true;
    const ok =
      required === 'device'
        ? principal.roles.some((r) => r === 'device' || ROLE_RANK[r] >= ROLE_RANK.operator)
        : principal.roles.some((r) => r !== 'device' && ROLE_RANK[r] >= ROLE_RANK[required]);
    if (!ok) throw new ForbiddenException(`requires role ${required}`);
    return true;
  }
}

const LoginBody = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) });

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Local credential exchange → JWT. In production, point the Gravitee JWT
   * plan / this endpoint at the customer IdP (Keycloak, Entra ID, UAE PASS).
   */
  @Public()
  @Post('token')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>) {
    const users: { username: string; password?: string; roles: Role[] }[] = [
      { username: this.env.AUTH_ADMIN_USERNAME, password: this.env.AUTH_ADMIN_PASSWORD, roles: ['admin'] },
      { username: this.env.AUTH_VIEWER_USERNAME, password: this.env.AUTH_VIEWER_PASSWORD, roles: ['viewer'] },
    ];
    const user = users.find((u) => u.password && u.username === body.username && safeEqual(u.password, body.password));
    if (!user) throw new UnauthorizedException('invalid credentials');
    const token = this.tokens.sign({ sub: user.username, tenantId: this.env.TENANT_ID, roles: user.roles });
    return { ...token, tokenType: 'Bearer', user: { username: user.username, roles: user.roles, tenantId: this.env.TENANT_ID } };
  }
}

@Module({
  controllers: [AuthController],
  providers: [TokenService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService],
})
export class AuthModule {}
