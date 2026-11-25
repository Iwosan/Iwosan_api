import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { API_BEARER_AUTH_SCHEME } from '../../common/constants/swagger.constants';
import { CrossBorderService } from './cross-border.service';
import { CreateCrossBorderPaymentDto } from './dto/cross-border.dto';

type AuthenticatedRequest = Request & {
  user?: { userId?: string; id?: string };
};

@ApiTags('payments')
@ApiBearerAuth(API_BEARER_AUTH_SCHEME)
@UseGuards(JwtAuthGuard)
@Controller('payments/cross-border')
export class CrossBorderController {
  constructor(private readonly crossBorderService: CrossBorderService) {}

  @Post()
  @ApiOperation({ summary: 'Pay for an order or treatment campaign through a SEP-31 anchor' })
  @ApiResponse({ status: 201, description: 'Payment started; anchor status returned' })
  @ApiResponse({ status: 502, description: 'Anchor rejected the customers or the payment' })
  create(@Body() dto: CreateCrossBorderPaymentDto, @Req() req: AuthenticatedRequest) {
    return this.crossBorderService.initiate(dto, this.userId(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get the status of a cross-border payment' })
  @ApiResponse({ status: 200, description: 'Payment status' })
  @ApiResponse({ status: 404, description: 'Payment not found for this user' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.crossBorderService.findOne(id, this.userId(req));
  }

  private userId(req: AuthenticatedRequest): string {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }
    return userId;
  }
}
