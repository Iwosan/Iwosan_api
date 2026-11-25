import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { API_BEARER_AUTH_SCHEME } from '../../common/constants/swagger.constants';
import { FeeBumpDto, SponsorAccountDto } from '../dto/sponsorship.dto';
import { StellarSponsorshipService } from '../services/stellar-sponsorship.service';

type AuthenticatedRequest = Request & {
  user?: { userId?: string; id?: string };
};

@ApiTags('stellar')
@ApiBearerAuth(API_BEARER_AUTH_SCHEME)
@UseGuards(JwtAuthGuard)
@Controller('stellar')
export class StellarSponsorshipController {
  constructor(private readonly sponsorshipService: StellarSponsorshipService) {}

  @Post('sponsor-account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sponsor a new account and its USDC trustline',
    description:
      'Returns the sponsored-reserve transaction for the payer. Send it back as ' +
      '`signedXdr` after the new account signs it to create the account.',
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction built, or submitted when signedXdr is sent',
  })
  @ApiResponse({ status: 429, description: 'Per-user sponsorship limit reached' })
  sponsorAccount(@Body() dto: SponsorAccountDto, @Req() req: AuthenticatedRequest) {
    return this.sponsorshipService.sponsorAccount(this.userId(req), dto.publicKey, dto.signedXdr);
  }

  @Post('fee-bump')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pay the network fee for a signed user transaction' })
  @ApiResponse({ status: 200, description: 'Fee-bump submitted; hash returned' })
  @ApiResponse({ status: 429, description: 'Per-user fee-bump limit reached' })
  feeBump(@Body() dto: FeeBumpDto, @Req() req: AuthenticatedRequest) {
    return this.sponsorshipService.submitFeeBump(this.userId(req), dto.xdr);
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }
    return userId;
  }
}
