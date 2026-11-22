import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthRateLimit } from '../../common/throttler/throttler.decorator';
import { AuthResponse } from '../services/auth.service';
import { StellarAuthService } from '../services/stellar-auth.service';
import { StellarChallengeQueryDto, StellarTokenDto } from '../dto/stellar-auth.dto';

@ApiTags('Authentication')
@Controller('auth/stellar')
export class StellarAuthController {
  constructor(private readonly stellarAuthService: StellarAuthService) {}

  /**
   * SEP-10 challenge for wallet login. The wallet signs the returned
   * transaction and posts it to /auth/stellar/token.
   */
  @Public()
  @Get('challenge')
  @AuthRateLimit()
  @ApiOperation({ summary: 'Get a SEP-10 challenge transaction for wallet login' })
  @ApiQuery({ name: 'account', description: 'Stellar public key (G...)', required: true })
  @ApiResponse({ status: 200, description: 'Challenge transaction returned' })
  @ApiResponse({ status: 400, description: 'Invalid Stellar account' })
  getChallenge(@Query() query: StellarChallengeQueryDto) {
    return this.stellarAuthService.createChallenge(query.account);
  }

  /**
   * Verify a signed SEP-10 challenge and issue the usual JWT token pair.
   */
  @Public()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Verify a signed SEP-10 challenge and issue tokens' })
  @ApiResponse({ status: 200, description: 'Wallet authenticated' })
  @ApiResponse({ status: 401, description: 'Challenge expired, tampered, or replayed' })
  authenticate(@Body() dto: StellarTokenDto, @Req() req: Request): Promise<AuthResponse> {
    return this.stellarAuthService.authenticate(dto, this.getIpAddress(req), req.get('user-agent'));
  }

  private getIpAddress(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
