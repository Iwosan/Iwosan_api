import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { Public } from '../common/decorators/public.decorator';
import { CreateListingDto, ListListingsQueryDto } from './dto/create-listing.dto';
import { MarketplaceService } from './marketplace.service';
import { PriceService } from './price.service';

@ApiTags('marketplace')
@Controller('marketplace/listings')
export class MarketplaceController {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly priceService: PriceService,
  ) {}

  @Public()
  @Get()
  async findAll(@Query() query: ListListingsQueryDto) {
    const listings = await this.marketplaceService.findAll(query);
    if (!query.currency) {
      return listings;
    }
    return this.priceService.addDisplayPrices(listings, query.currency);
  }

  @Public()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketplaceService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateListingDto, @Req() req: any) {
    return this.marketplaceService.create(this.userId(req), dto);
  }

  @Patch(':id/verify')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.marketplaceService.verify(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.marketplaceService.deactivate(id, this.userId(req));
  }

  private userId(req: any): string {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required');
    }
    return userId;
  }
}
