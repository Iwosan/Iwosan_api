import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { API_BEARER_AUTH_SCHEME } from '../../common/constants/swagger.constants';
import { AnchorService } from './anchor.service';
import { AnchorInteractionDto } from './dto/anchor.dto';

type AuthenticatedRequest = Request & {
  user?: { userId?: string; id?: string };
};

@ApiTags('payments')
@ApiBearerAuth(API_BEARER_AUTH_SCHEME)
@UseGuards(JwtAuthGuard)
@Controller('payments/anchor')
export class AnchorController {
  constructor(private readonly anchorService: AnchorService) {}

  @Post('deposit')
  @ApiOperation({ summary: 'Start a SEP-24 interactive cash deposit' })
  @ApiResponse({ status: 201, description: 'Anchor URL returned' })
  @ApiResponse({ status: 502, description: 'Anchor unavailable or asset unsupported' })
  deposit(@Body() dto: AnchorInteractionDto, @Req() req: AuthenticatedRequest) {
    return this.anchorService.startDeposit(dto, this.userId(req));
  }

  @Post('withdraw')
  @ApiOperation({ summary: 'Start a SEP-24 interactive cash withdrawal' })
  @ApiResponse({ status: 201, description: 'Anchor URL returned' })
  @ApiResponse({ status: 502, description: 'Anchor unavailable or asset unsupported' })
  withdraw(@Body() dto: AnchorInteractionDto, @Req() req: AuthenticatedRequest) {
    return this.anchorService.startWithdraw(dto, this.userId(req));
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }
    return userId;
  }
}
